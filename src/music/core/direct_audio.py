"""Header-free, bounded full-audio probe for native WeChat background playback.

This is a server-side preflight, not proof of device/WeChat compatibility.
"""

import asyncio
from dataclasses import replace
from urllib.parse import urlsplit

from music.core.errors import AppError
from music.db.models import now
from music.providers.matching import duration_matches


class DirectAudioCheck:
    def __init__(self, probe, timeout=30):
        self.probe, self.timeout = probe, timeout

    async def check(self, verified):
        audio = verified.audio
        if audio.audio_kind != "full" or urlsplit(audio.url).scheme != "https":
            raise self.unsupported()
        if audio.expires_at and audio.expires_at <= now():
            raise self.unsupported()
        # All ranges and redirects use the existing public-IP-pinned transport;
        # never upgrade plain HTTP or forward platform-only headers to the client
        direct = replace(audio, headers={}, https_only=True)
        try:
            async with asyncio.timeout(self.timeout):
                duration = await self.probe.duration(direct, self.timeout)
            if not duration_matches(duration, verified.track.duration) or not duration_matches(
                duration, verified.duration
            ):
                raise self.unsupported()
        except AppError as exc:
            if exc.code == "service_busy":
                raise
            raise self.unsupported() from None
        except TimeoutError:
            raise self.unsupported() from None
        return audio.url

    @staticmethod
    def unsupported():
        return AppError(
            "direct_audio_unsupported",
            "当前完整版音源不支持小程序直连或无法可靠验证，Web 可用性不受影响",
            409,
        )
