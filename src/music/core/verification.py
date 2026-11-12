"""Full-recording resolution without preview fallback or third-party parsers"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass

from music.core.errors import AppError
from music.providers.matching import duration_matches, same_recording
from music.providers.official import ResolvedAudio, Track

TRANSIENT_ERRORS = {
    "upstream_timeout",
    "upstream_rate_limited",
    "upstream_error",
    "upstream_changed",
    "probe_network_error",
    "stream_network_error",
    "verification_timeout",
}


class FullAudioUnavailable(AppError):
    def __init__(
        self, message="当前没有可确认的完整版音频，已暂时隐藏，稍后自动重新检查", retryable=False
    ):
        super().__init__("full_audio_unavailable", message, 409, hidden=True)
        self.retryable = retryable


@dataclass
class VerifiedAudio:
    track: Track
    audio: ResolvedAudio
    duration: float


class FullAudioResolver:
    def __init__(self, providers, probe, settings):
        self.providers, self.probe, self.settings = providers, probe, settings

    async def resolve(self, original: Track, preferred: Track | None = None, only_preferred=False):
        errors = []
        attempted = set()
        try:
            async with asyncio.timeout(self.settings.full_audio_verify_timeout):
                deadline = (
                    asyncio.get_running_loop().time() + self.settings.full_audio_verify_timeout
                )

                async def verify(track):
                    key = (track.source, track.source_track_id)
                    if key in attempted:
                        return None
                    attempted.add(key)
                    try:
                        audio = await self.providers.resolve(*key)
                        # The Soda share-page field is named audition_url, but can contain
                        # full audio during official promotions; actual bytes decide
                        if track.source != "soda" and audio.audio_kind == "preview":
                            return None
                        remaining = deadline - asyncio.get_running_loop().time()
                        if remaining <= 0:
                            raise TimeoutError
                        duration = await self.probe.duration(audio, remaining)
                        if duration_matches(duration, track.duration) and duration_matches(
                            duration, original.duration
                        ):
                            audio.audio_kind = "full"
                            return VerifiedAudio(track, audio, duration)
                    except AppError as exc:
                        if exc.code == "service_busy":
                            raise
                        errors.append(exc.code)
                    return None

                if preferred:
                    is_original = (preferred.source, preferred.source_track_id) == (
                        original.source,
                        original.source_track_id,
                    )
                    if is_original or same_recording(original, preferred):
                        if result := await verify(preferred):
                            return result
                if not only_preferred:
                    if result := await verify(original):
                        return result
                    for source in self.settings.fallback_sources:
                        if source == original.source or source not in self.providers.providers:
                            continue
                        try:
                            candidates = await self.providers.search(
                                source, f"{original.title} {original.artist}", 1, 20
                            )
                        except AppError as exc:
                            if exc.code == "service_busy":
                                raise
                            errors.append(exc.code)
                            continue
                        matching = [
                            track for track in candidates if same_recording(original, track)
                        ]
                        for candidate in matching[:3]:
                            if result := await verify(candidate):
                                return result
        except TimeoutError:
            raise FullAudioUnavailable(
                "完整版验证超过时限，已暂时隐藏，冷却后自动重试", retryable=True
            ) from None
        if any(error in TRANSIENT_ERRORS for error in errors):
            raise FullAudioUnavailable(
                "音乐平台暂时不可用或验证失败，已暂时隐藏，冷却后自动重试", retryable=True
            )
        raise FullAudioUnavailable()
