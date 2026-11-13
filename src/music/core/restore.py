"""Restore stable platform identities without trusting client metadata."""

import asyncio
import hashlib

from sqlalchemy import select

from music.core.errors import AppError
from music.db.models import Song, now


async def restore_song(service, source, track_id, hint):
    if source not in service.providers.providers:
        raise AppError("invalid_source", "不支持的音乐来源", 400)
    key = f"restore:{source}:{track_id}"
    async with service.locks.get(key):
        async with service.db.sessions() as db:
            song = await db.scalar(
                select(Song).where(Song.source == source, Song.source_track_id == track_id)
            )
        if not song:
            # The normal bounded search queue/cache is reused, never resolve audio here.
            cache_key = f"restore-miss:{source}:{track_id}"
            cached = await service.cache(cache_key)
            if cached and cached.expires_at > now():
                return {
                    "status": "unavailable",
                    "song": None,
                    "message": "当前未能恢复此平台歌曲，稍后再试",
                }
            async with asyncio.timeout(service.settings.full_audio_verify_timeout):
                await service.search(source, hint, 1)
                # Wait only for metadata, not for audio verification of the whole search batch.
                search_key = "search:" + hashlib.sha256(f"{source}:{hint}:1".encode()).hexdigest()
                task = service.search_tasks.get(search_key)
                if task:
                    await asyncio.shield(task)
                async with service.db.sessions() as db:
                    song = await db.scalar(
                        select(Song).where(Song.source == source, Song.source_track_id == track_id)
                    )
            if not song:
                await service.set_cache(cache_key, {}, service.settings.failure_cooldown)
                return {
                    "status": "unavailable",
                    "song": None,
                    "message": "未找到相同平台 ID 的歌曲，不替换为其他版本",
                }
        await service.enqueue([song.id])
        songs = await service.songs([song.id])
        if songs:
            return {"status": "available", "song": songs[0], "message": ""}
        async with service.db.sessions() as db:
            song = await db.get(Song, song.id)
        pending = song.verification_state in ("pending", "verifying")
        return {
            "status": "pending" if pending else "unavailable",
            "song": None,
            "message": "正在验证可播放完整版" if pending else "歌曲暂不可播放，记录仍保留",
        }
