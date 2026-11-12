"""Bounded, seekable HTTP reads for audio duration metadata

All network access goes through AudioProxy (public-IP pinning and redirect checks)
The parser only reads container metadata; files are never saved or fully buffered
"""

from __future__ import annotations

import asyncio
import io
import math
import re
import threading
import time
from concurrent.futures import TimeoutError as FutureTimeout

import httpx

from music.core.errors import AppError
from music.core.limits import BoundedExecutor
from music.core.streaming import audio_content

BLOCK_SIZE = 32768
MAX_BYTES = 1024 * 1024
MAX_REQUESTS = 32
MAX_READS = 2048


class ProbeUnsupported(OSError):
    pass


class RangeFile(io.RawIOBase):
    def __init__(self, size, initial, fetch, deadline, stopped):
        self.size, self.fetch, self.deadline, self.stopped = size, fetch, deadline, stopped
        self.position = 0
        self.name = "audio"
        self.blocks = {0: initial}
        self.bytes_read = len(initial)
        self.requests = 1
        self.reads = 0

    def readable(self):
        return True

    def seekable(self):
        return True

    def tell(self):
        return self.position

    def seek(self, offset, whence=0):
        target = (
            offset
            if whence == 0
            else self.position + offset
            if whence == 1
            else self.size + offset
            if whence == 2
            else -1
        )
        if target < 0:
            raise ProbeUnsupported("Invalid audio seek")
        self.position = target
        return target

    def read(self, count=-1):
        self.reads += 1
        if self.stopped.is_set() or time.monotonic() >= self.deadline or self.reads > MAX_READS:
            raise ProbeUnsupported("Audio metadata deadline exceeded")
        count = self.size - self.position if count is None or count < 0 else count
        count = min(count, max(0, self.size - self.position))
        if count > MAX_BYTES:
            raise ProbeUnsupported("Metadata read too large")
        chunks = []
        while count:
            start = self.position // BLOCK_SIZE * BLOCK_SIZE
            if start not in self.blocks:
                if self.requests >= MAX_REQUESTS or self.bytes_read >= MAX_BYTES:
                    raise ProbeUnsupported("Audio metadata budget exceeded")
                block = self.fetch(start, min(self.size - 1, start + BLOCK_SIZE - 1))
                self.requests += 1
                self.bytes_read += len(block)
                if self.bytes_read > MAX_BYTES:
                    raise ProbeUnsupported("Audio metadata budget exceeded")
                self.blocks[start] = block
            block = self.blocks[start]
            relative = self.position - start
            take = min(count, len(block) - relative)
            if take <= 0:
                raise ProbeUnsupported("Truncated audio metadata")
            chunks.append(block[relative : relative + take])
            self.position += take
            count -= take
        return b"".join(chunks)

    def readinto(self, buffer):
        data = self.read(len(buffer))
        buffer[: len(data)] = data
        return len(data)


def parse_duration(file):
    import mutagen
    from mutagen.flac import FLAC
    from mutagen.mp3 import MP3
    from mutagen.mp4 import MP4
    from mutagen.wave import WAVE

    parsed = mutagen.File(file, options=[MP3, MP4, FLAC, WAVE])
    if parsed is None or not parsed.info or getattr(parsed.info, "sketchy", False):
        raise ProbeUnsupported("Unrecognized audio container")
    duration = float(parsed.info.length)
    if not math.isfinite(duration) or duration <= 0:
        raise ProbeUnsupported("Unknown audio duration")
    if isinstance(parsed, MP4) and not getattr(parsed.info, "codec", "").startswith(
        ("mp4a", "alac")
    ):
        raise ProbeUnsupported("Unsupported or protected audio codec")
    return duration


class AudioProbe:
    def __init__(self, proxy, concurrency=2):
        self.proxy = proxy
        self.executor = BoundedExecutor(concurrency, concurrency, "audio-metadata")

    def close(self):
        self.executor.close()

    async def _range(self, audio, start, end, expected_size=None):
        upstream = await self.proxy.open(audio.url, audio.headers, f"bytes={start}-{end}")
        try:
            response = upstream.response
            if response.status_code in (401, 403, 404, 410):
                raise AppError("probe_link_unavailable", "当前音频地址不可用")
            if response.status_code == 429 or response.status_code >= 500:
                raise AppError("probe_network_error", "音频服务器暂时不可用")
            match = re.fullmatch(
                r"bytes (\d+)-(\d+)/(\d+)", response.headers.get("content-range", "")
            )
            if response.status_code != 206 or not match:
                raise AppError("probe_unknown", "音频服务器不支持有界时长验证")
            actual_start, actual_end, size = map(int, match.groups())
            if (
                actual_start != start
                or actual_end != min(end, size - 1)
                or size <= actual_end
                or (expected_size is not None and size != expected_size)
            ):
                raise AppError("probe_unknown", "音频范围响应不一致")
            if response.headers.get("content-encoding", "identity") != "identity":
                raise AppError("probe_unknown", "音频传输编码不支持时长验证")
            data = bytearray()
            expected = actual_end - actual_start + 1
            async for chunk in upstream.iterator:
                data.extend(chunk[: expected - len(data)])
                if len(data) >= expected:
                    break
            if len(data) != expected:
                raise AppError("probe_unknown", "音频元数据响应不完整")
            if start == 0 and not audio_content(response.headers, bytes(data), None):
                raise AppError("probe_unknown", "返回内容不是可识别音频")
            return bytes(data), size
        finally:
            await upstream.close()

    async def duration(self, audio, timeout=30):
        loop = asyncio.get_running_loop()
        deadline = time.monotonic() + timeout
        stopped = threading.Event()
        pending = set()
        lock = threading.Lock()
        try:
            async with asyncio.timeout(timeout):
                first, size = await self._range(audio, 0, BLOCK_SIZE - 1)

                def fetch(start, end):
                    if stopped.is_set():
                        raise ProbeUnsupported("Audio probe cancelled")
                    future = asyncio.run_coroutine_threadsafe(
                        self._range(audio, start, end, size), loop
                    )
                    with lock:
                        if stopped.is_set():
                            future.cancel()
                            raise ProbeUnsupported("Audio probe cancelled")
                        pending.add(future)
                    try:
                        return future.result(timeout=max(0.01, deadline - time.monotonic()))[0]
                    except FutureTimeout as exc:
                        future.cancel()
                        raise ProbeUnsupported("Audio metadata deadline exceeded") from exc
                    finally:
                        with lock:
                            pending.discard(future)

                reader = RangeFile(size, first, fetch, deadline, stopped)
                return await self.executor.call(parse_duration, reader)
        except (TimeoutError, httpx.HTTPError) as exc:
            raise AppError("probe_network_error", "验证音频时网络超时或连接失败") from exc
        except AppError:
            raise
        except Exception as exc:
            raise AppError("probe_unknown", "无法可靠读取当前音频的可播放时长") from exc
        finally:
            stopped.set()
            with lock:
                for future in pending:
                    future.cancel()
