"""Fail-fast resource admission, including work that outlives a cancelled awaiter."""

import asyncio
from concurrent.futures import ThreadPoolExecutor
from functools import partial

from music.core.errors import AppError


def busy():
    return AppError("service_busy", "服务繁忙，请稍后重试", 503)


class Lease:
    def __init__(self, release):
        self._release = release
        self.released = False

    def release(self):
        if not self.released:
            self.released = True
            self._release()


class Capacity:
    """All admission and release happens on the owning asyncio event loop."""

    def __init__(self, limit):
        self.limit = limit
        self.active = 0

    def acquire(self):
        if self.active >= self.limit:
            raise busy()
        self.active += 1
        return Lease(self._release)

    def _release(self):
        self.active -= 1


class BoundedExecutor:
    def __init__(self, workers, queue_size, name):
        self.pool = ThreadPoolExecutor(max_workers=workers, thread_name_prefix=name)
        self.capacity = Capacity(workers + queue_size)
        self.closed = False

    async def call(self, function, *args):
        if self.closed:
            raise busy()
        lease = self.capacity.acquire()
        loop = asyncio.get_running_loop()
        try:
            work = self.pool.submit(partial(function, *args))
        except BaseException:
            lease.release()
            raise

        def completed(_):
            try:
                loop.call_soon_threadsafe(lease.release)
            except RuntimeError:
                pass  # The application event loop has already stopped

        work.add_done_callback(completed)
        future = asyncio.wrap_future(work)
        # Cancellation must not free a slot while the thread still runs, nor create
        # an unbounded backlog of cancelled executor WorkItems behind a stuck job
        future.add_done_callback(lambda done: done.exception() if not done.cancelled() else None)
        return await asyncio.shield(future)

    def close(self):
        self.closed = True
        self.pool.shutdown(wait=False, cancel_futures=True)
