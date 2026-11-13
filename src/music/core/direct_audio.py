"""Bounded full-audio preflight without platform-only headers.

Official NetEase/Kuwo CDN HTTP URLs may be tested as HTTPS on the same host.
Only an actually validated HTTPS resource is ever returned to the native player.
This is not proof of device/WeChat compatibility.
"""

import asyncio
from dataclasses import replace
from urllib.parse import urlsplit

from music.core.errors import AppError
from music.db.models import now
from music.providers.matching import duration_matches

# Not a general URL rewriting service: only official provider/CDN namespaces
HTTPS_UPGRADE_HOSTS = {"netease": "music.126.net", "kuwo": "kuwo.cn"}


def direct_candidate_url(url: str, source: str) -> str:
    try:
        parsed = urlsplit(url)
        if not parsed.hostname or parsed.username or parsed.password:
            raise ValueError
        if parsed.scheme == "https" and parsed.port in (None, 443):
            return url
        if parsed.scheme == "http" and parsed.port in (None, 80):
            suffix = HTTPS_UPGRADE_HOSTS.get(source)
            host = parsed.hostname
            if suffix and (host == suffix or host.endswith("." + suffix)):
                # Preserve path/query/signature, never guess a different CDN hostname
                return parsed._replace(scheme="https", netloc=host).geturl()
    except ValueError:
        pass
    raise DirectAudioCheck.unsupported("https_required")


class DirectAudioCheck:
    def __init__(self, probe, timeout=30):
        self.probe, self.timeout = probe, timeout

    async def check(self, verified):
        audio = verified.audio
        if audio.audio_kind != "full":
            raise self.unsupported("not_full")
        candidate = direct_candidate_url(audio.url, verified.track.source)
        if audio.expires_at and audio.expires_at <= now():
            raise self.unsupported("expired")
        # The strict transport pins public IPs, validates TLS/redirects and uses
        # a generic browser UA. No provider Referer, Origin, Cookie or secrets
        direct = replace(audio, url=candidate, headers={}, https_only=True)
        try:
            async with asyncio.timeout(self.timeout):
                duration = await self.probe.duration(direct, self.timeout)
            if not duration_matches(duration, verified.track.duration) or not duration_matches(
                duration, verified.duration
            ):
                raise self.unsupported("duration_mismatch")
        except AppError as exc:
            if exc.code in ("service_busy", "direct_audio_unsupported"):
                raise
            raise self.unsupported(exc.code) from None
        except TimeoutError:
            raise self.unsupported("probe_network_error") from None
        return candidate

    @staticmethod
    def unsupported(reason="unknown"):
        notes = {
            "https_required": "平台未提供可验证的安全 HTTPS 音源",
            "not_full": "未确认完整版",
            "expired": "临时链接已过期",
            "duration_mismatch": "实际音频时长与完整版不符",
            "probe_link_unavailable": "HTTPS 音源拒绝访问或链接已失效",
            "probe_network_error": "验证音源时网络超时或连接失败",
            "probe_unknown": "无法可靠确认当前音频的完整时长",
            "unsafe_audio_url": "音源或跳转未通过 HTTPS 公网地址安全检查",
        }
        detail = "（" + notes[reason] + "）" if reason in notes else ""
        return AppError(
            "direct_audio_unsupported",
            "当前完整版音源不支持小程序直连或无法可靠验证" + detail + "，Web 可用性不受影响",
            409,
        )
