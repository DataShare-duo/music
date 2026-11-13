"""Bounded line-level lyric parsing and caching, independent of audio resolution."""

import asyncio
import math
import re
from dataclasses import dataclass, field
from datetime import datetime
from html import unescape
from typing import Literal

from pydantic import BaseModel, Field

from music.core.errors import AppError
from music.db.models import now
from music.providers.official import SOURCE_NAMES

MAX_TEXT_BYTES = 65536
MAX_LINES = 2000
STAMP = re.compile(r"\[(\d{1,4}):(\d{1,2})(?:[.:](\d{1,4}))?\]")
OFFSET = re.compile(r"\[offset:([+-]?\d{1,9})\]", re.I)
TAG = re.compile(r"\[[a-z][a-z0-9_-]*:[^\]]*\]", re.I)
WORD_STAMP = re.compile(r"<\d{1,4}:\d{1,2}(?:\.\d{1,4})?>")
MARKERS = {"纯音乐", "纯音乐，请欣赏", "纯音乐,请欣赏", "instrumental", "music only"}


@dataclass
class LyricPayload:
    text: str = ""
    rows: list[dict] = field(default_factory=list)
    instrumental: bool = False


class LyricLine(BaseModel):
    time_ms: int = Field(ge=0)
    text: str


class LyricsView(BaseModel):
    status: Literal["synced", "plain", "unavailable", "instrumental", "error"]
    source: str
    source_name: str
    source_track_id: str
    lines: list[LyricLine] = Field(default_factory=list)
    plain_text: str = ""
    fetched_at: datetime
    retry_after: int = 0
    message: str = ""


def limited():
    return AppError("lyrics_too_large", "歌词超过安全解析上限", 502)


def clean_text(value):
    value = unescape(str(value or "")).strip("\ufeff \t\r\n")
    return re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", value)


def parse_lyrics(payload):
    if len(payload.text.encode("utf-8")) > MAX_TEXT_BYTES or len(payload.rows) > MAX_LINES:
        raise limited()
    original = payload.text.lstrip("\ufeff").replace("\r\n", "\n").replace("\r", "\n")
    offsets = OFFSET.findall(original)
    offset = max(-86400000, min(86400000, int(offsets[-1]))) if offsets else 0
    timed, plain = [], []
    if len(original.splitlines()) > MAX_LINES:
        raise limited()
    for row in original.splitlines():
        stamps = list(STAMP.finditer(row))
        text = clean_text(WORD_STAMP.sub("", TAG.sub("", STAMP.sub("", row))))
        if not text or text.casefold() in {"null", "none"}:
            continue
        if stamps:
            for stamp in stamps:
                minute, second, fraction = stamp.groups()
                if int(second) >= 60:
                    continue
                value = (
                    int(minute) * 60000 + int(second) * 1000 + int(((fraction or "0") + "000")[:3])
                )
                if value >= 86400000:
                    continue
                # LRC positive offsets advance lyrics relative to audio playback
                timed.append((max(0, value - offset), text))
        else:
            plain.append(text)
    for row in payload.rows:
        text = clean_text(row.get("lineLyric"))
        if not text:
            continue
        try:
            seconds = float(row.get("time"))
            if not math.isfinite(seconds) or not 0 <= seconds < 86400:
                raise ValueError
            timed.append((round(seconds * 1000), text))
        except (ValueError, TypeError, OverflowError):
            plain.append(text)
    if (
        len(timed) > MAX_LINES
        or sum(len(text.encode("utf-8")) for _, text in timed)
        + sum(len(text.encode("utf-8")) for text in plain)
        > MAX_TEXT_BYTES
    ):
        raise limited()
    texts = [text for _, text in timed] + plain
    if payload.instrumental or (texts and all(text.casefold() in MARKERS for text in texts)):
        return "instrumental", [], ""
    grouped = {}
    for stamp, text in sorted(timed, key=lambda item: item[0]):
        group = grouped.setdefault(stamp, [])
        if text not in group:
            group.append(text)
    if grouped:
        return (
            "synced",
            [LyricLine(time_ms=stamp, text="\n".join(texts)) for stamp, texts in grouped.items()],
            "",
        )
    if plain:
        return "plain", [], "\n".join(plain)
    return "unavailable", [], ""


class LyricsService:
    def __init__(self, service):
        self.service = service

    async def get(self, playback_id):
        service = self.service
        pb = await service.get_playback(playback_id, "direct")
        track = pb.play_track or {}
        source, track_id = pb.play_source, str(track.get("source_track_id") or "")
        if (
            source not in SOURCE_NAMES
            or track.get("source") != source
            or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", track_id)
        ):
            raise AppError(
                "lyrics_not_ready", "当前会话没有实际音源信息，请先选择歌曲播放", 409, pb.id
            )
        key = f"lyrics:v1:{source}:{track_id}"
        async with service.locks.get(key):
            cached = await service.cache(key)
            if cached and cached.expires_at > now():
                try:
                    view = LyricsView.model_validate(cached.value)
                except (ValueError, TypeError):
                    view = None
                if view and view.source == source and view.source_track_id == track_id:
                    return view.model_copy(
                        update={
                            "retry_after": max(
                                1, math.ceil((cached.expires_at - now()).total_seconds())
                            )
                            if view.status == "error"
                            else 0
                        }
                    )
            try:
                async with asyncio.timeout(min(service.settings.network_timeout, 10)):
                    payload = await service.providers.lyrics(source, track_id)
                status, lines, plain = parse_lyrics(payload)
                ttl = 86400 if status in ("synced", "plain") else 21600
                message = {
                    "synced": "",
                    "plain": "音源未提供歌词时间轴",
                    "unavailable": "暂无歌词",
                    "instrumental": "纯音乐，请欣赏",
                }[status]
            except asyncio.CancelledError:
                raise
            except Exception:
                # Lyrics errors never hide a song, fail playback or leak upstream data
                status, lines, plain = "error", [], ""
                ttl = max(1, service.settings.failure_cooldown)
                message = "歌词暂时获取失败，稍后可重试"
            view = LyricsView(
                status=status,
                source=source,
                source_name=SOURCE_NAMES[source],
                source_track_id=track_id,
                lines=lines,
                plain_text=plain,
                fetched_at=now(),
                retry_after=ttl if status == "error" else 0,
                message=message,
            )
            try:
                await service.set_cache(key, view.model_dump(mode="json"), ttl)
            except Exception:
                # Do not propagate SQL exception parameters containing lyric text to logs
                return LyricsView(
                    status="error",
                    source=source,
                    source_name=SOURCE_NAMES[source],
                    source_track_id=track_id,
                    fetched_at=now(),
                    retry_after=max(1, service.settings.failure_cooldown),
                    message="歌词缓存暂不可用，不影响音乐播放",
                )
            return view
