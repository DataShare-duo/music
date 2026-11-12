import asyncio
import weakref


class Locks:
    """Inactive keys disappear instead of growing indefinitely"""

    def __init__(self):
        self._items = weakref.WeakValueDictionary()

    def get(self, key: str) -> asyncio.Lock:
        lock = self._items.get(key)
        if lock is None:
            lock = asyncio.Lock()
            self._items[key] = lock
        return lock
