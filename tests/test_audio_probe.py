import io
import re
import wave

import httpx
import pytest

from music.core.audio_probe import BLOCK_SIZE, MAX_BYTES, AudioProbe, ProbeUnsupported, RangeFile
from music.core.errors import AppError
from music.providers.official import ResolvedAudio


def wav_bytes(seconds=10):
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(8000)
        audio.writeframes(b"\0\0" * (8000 * seconds))
    return buffer.getvalue()


class ByteStream:
    def __init__(self, response, data):
        self.response, self.closed = response, False

        async def chunks():
            yield data

        self.iterator = chunks()

    async def close(self):
        self.closed = True


class ByteProxy:
    def __init__(self, content):
        self.content, self.streams = content, []
        self.bytes = 0
        self.status = 206
        self.mime = "audio/wav"

    async def open(self, url, headers, range_header):
        first, last = map(int, re.fullmatch(r"bytes=(\d+)-(\d+)", range_header).groups())
        last = min(last, len(self.content) - 1)
        part = self.content[first : last + 1]
        self.bytes += len(part)
        response = httpx.Response(
            self.status,
            headers={
                "content-type": self.mime,
                "content-range": f"bytes {first}-{last}/{len(self.content)}",
            },
        )
        stream = ByteStream(response, part)
        self.streams.append(stream)
        return stream


async def test_bounded_range_probe_reads_real_wav_duration_without_whole_download():
    content = wav_bytes()
    proxy = ByteProxy(content)
    probe = AudioProbe(proxy)
    try:
        duration = await probe.duration(ResolvedAudio("https://audio.example/test.wav", {}))
        assert duration == 10
        assert 0 < proxy.bytes < len(content)
        assert proxy.bytes <= MAX_BYTES
        assert all(stream.closed for stream in proxy.streams)
    finally:
        probe.close()


async def test_no_range_support_or_html_not_accepted_as_full_audio():
    proxy = ByteProxy(b"<html>access denied</html>" * 3000)
    probe = AudioProbe(proxy)
    try:
        with pytest.raises(AppError):
            await probe.duration(ResolvedAudio("https://audio.example/test.wav", {}))
        proxy.status = 200
        with pytest.raises(AppError):
            await probe.duration(ResolvedAudio("https://audio.example/test.wav", {}))
        assert all(stream.closed for stream in proxy.streams)
    finally:
        probe.close()


async def test_probe_network_error_is_retryable_classification():
    class Offline:
        async def open(self, *args):
            raise httpx.ReadTimeout("timeout")

    probe = AudioProbe(Offline())
    try:
        with pytest.raises(AppError) as error:
            await probe.duration(ResolvedAudio("https://audio.example/test.mp3", {}))
        assert error.value.code == "probe_network_error"
    finally:
        probe.close()


def test_range_reader_seeks_and_rejects_unbounded_metadata():
    import threading
    import time

    reader = RangeFile(
        MAX_BYTES * 2,
        b"a" * BLOCK_SIZE,
        lambda start, end: b"b" * (end - start + 1),
        time.monotonic() + 10,
        threading.Event(),
    )
    assert reader.read(3) == b"aaa"
    reader.seek(BLOCK_SIZE)
    assert reader.read(2) == b"bb"
    reader.seek(0)
    with pytest.raises(ProbeUnsupported):
        reader.read()
