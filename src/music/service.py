from __future__ import annotations

import asyncio
import hashlib
import logging
from datetime import timedelta
from uuid import uuid4

from sqlalchemy import func, select, update

from music.catalog import CatalogService, track_of
from music.core.errors import AppError
from music.core.limits import busy
from music.core.verification import FullAudioUnavailable
from music.db.models import AudioLink, Playback, Song, SongStats, now
from music.providers.official import SOURCE_NAMES, Track
from music.schemas.api import PlaybackView, SongList

logger = logging.getLogger(__name__)


class MusicService(CatalogService):
    async def _refresh_search(self, key, source, query, page, cached):
        try:
            tracks = await self.providers.search(source, query, page, 20)
            ids = await self.upsert_tracks(tracks)
            await self.set_cache(
                key, {"ids": ids, "has_more": len(tracks) == 20}, self.settings.search_ttl
            )
            await self.enqueue(ids)
        except AppError as exc:
            value = dict(cached.value) if cached else {"ids": [], "has_more": False}
            value["message"], value["failed"] = exc.message, True
            await self.set_cache(key, value, self.settings.failure_cooldown)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Search metadata task failed")
            value = dict(cached.value) if cached else {"ids": []}
            value.update(message="歌曲搜索暂时失败，冷却后自动重试", failed=True)
            await self.set_cache(key, value, self.settings.failure_cooldown)

    async def search(self, source, query, page):
        if source not in SOURCE_NAMES:
            raise AppError("invalid_source", "不支持的音乐来源", 400)
        key = "search:" + hashlib.sha256(f"{source}:{query}:{page}".encode()).hexdigest()
        async with self.locks.get(key):
            cached = await self.cache(key)
            task = self.search_tasks.get(key)
            running = bool(task and not task.done())
            overloaded = False
            if not running and (not cached or cached.expires_at <= now()):
                if len(self.search_tasks) >= self.settings.search_task_limit:
                    if not cached:
                        raise busy()
                    overloaded = True
                else:
                    self._schedule_search(key, source, query, page, cached)
                    running = True
            ids = cached.value.get("ids", []) if cached else []
            items = await self.songs(ids)
            progress = await self.progress(ids=ids)
            refreshing = running or bool(progress["verification_pending"])
            message = (
                "服务繁忙，暂时展示已有搜索结果"
                if overloaded
                else (cached.value.get("message") if cached else None)
            )
            if not message and refreshing:
                message = "正在验证可播放歌曲，结果会逐步展示"
            if not message and not refreshing and not items:
                message = "暂未找到可确认完整版的歌曲，系统会定期重新检查"
            return SongList(
                items=items,
                count=len(items),
                page=page,
                has_more=cached.value.get("has_more", False) if cached else False,
                refreshing=refreshing,
                stale=overloaded
                or bool(cached and (cached.expires_at <= now() or cached.value.get("failed"))),
                message=message,
                updated_at=cached.updated_at if cached else None,
                **progress,
            )

    def _schedule_search(self, key, source, query, page, cached):
        # No await between the capacity check and task registration on this loop
        task = asyncio.create_task(
            self._refresh_search(key, source, query, page, cached), name="search-metadata"
        )
        self.search_tasks[key] = task
        task.add_done_callback(
            lambda completed: (
                self.search_tasks.pop(key, None)
                if self.search_tasks.get(key) is completed
                else None
            )
        )

    async def home(self, ids=None):
        cached = await self.cache("catalog:soda")
        if (not self.catalog_task or self.catalog_task.done()) and (
            not cached or cached.expires_at <= now()
        ):
            self.catalog_task = asyncio.create_task(self.refresh_catalog(), name="catalog-refresh")
        items = await self.songs(home=True)
        if ids is not None:
            async with self.db.sessions() as db:
                eligible = set(
                    await db.scalars(
                        select(Song.id).where(
                            Song.id.in_(ids),
                            Song.recommended.is_(True),
                            Song.source == "soda",
                            Song.verification_state == "available",
                        )
                    )
                )
            previous = await self.songs([id_ for id_ in ids if id_ in eligible])
            seen = {song.id for song in previous}
            items = (previous + [song for song in items if song.id not in seen])[:100]
        progress = await self.progress(home=True)
        refreshing = bool(
            progress["verification_pending"] or (self.catalog_task and not self.catalog_task.done())
        )
        message = "正在验证可播放歌曲" if refreshing and not items else None
        if not items and not refreshing:
            message = "暂未找到可确认完整版的歌曲，系统会定期重新检查"
        return SongList(
            items=items,
            count=len(items),
            refreshing=refreshing,
            stale=bool(cached and cached.expires_at <= now()),
            message=message,
            updated_at=cached.updated_at if cached else None,
            **progress,
        )

    async def refresh_catalog(self):
        errors = []
        successes = 0
        count = 0
        async with self.locks.get("catalog:soda"):
            try:
                for page in (1, 2, 3):
                    for keyword in self.settings.keywords:
                        try:
                            tracks = await self.providers.search("soda", keyword, page, 20)
                            ids = await self.upsert_tracks(tracks, recommended=True)
                            await self.enqueue(ids)
                            successes += 1
                        except AppError as exc:
                            errors.append(exc.message)
                            if successes == 0 and len(errors) >= 3:
                                break
                        async with self.db.sessions() as db:
                            count = await db.scalar(
                                select(func.count())
                                .select_from(Song)
                                .where(
                                    Song.recommended.is_(True),
                                    Song.source == "soda",
                                    Song.verification_state == "available",
                                )
                            )
                        if count >= self.settings.catalog_target:
                            break
                        await asyncio.sleep(0.15)
                    if count >= self.settings.catalog_target or (
                        successes == 0 and len(errors) >= 3
                    ):
                        break
                await self.set_cache(
                    "catalog:soda",
                    {"failed": bool(errors), "message": errors[-1] if errors else None},
                    self.settings.catalog_ttl if not errors else self.settings.failure_cooldown,
                )
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("Catalog refresh failed")
                await self.set_cache(
                    "catalog:soda",
                    {"failed": True, "message": "曲库采集异常，请稍后自动重试"},
                    self.settings.failure_cooldown,
                )

    def playback_view(self, pb):
        source = pb.play_source
        return PlaybackView(
            id=pb.id,
            song_id=pb.song_id,
            state=pb.state,
            stream_url=f"/api/playbacks/{pb.id}/stream?v={pb.link_version}",
            audio_kind=pb.audio_kind,
            link_version=pb.link_version,
            refresh_count=pb.refresh_count,
            expires_at=pb.expires_at,
            play_source=source,
            play_source_name=SOURCE_NAMES.get(source, source) if source else None,
            audio_duration=pb.audio_duration,
            error={"code": pb.error_code, "message": pb.error_message} if pb.error_code else None,
        )

    async def _resolve_song(self, song, preferred=None):
        original = track_of(song)
        return await self.verifier.resolve(original, preferred=preferred)

    async def _save_playback(self, pb, verified):
        await self.save_verified(pb.song_id, verified, playback_id=pb.id)
        return await self.get_playback(pb.id)

    async def create_playback(self, song_id, request_id):
        async with self.locks.get(f"request:{request_id}"):
            async with self.db.sessions() as db:
                old = await db.scalar(
                    select(Playback).where(Playback.client_request_id == request_id)
                )
                if old:
                    if old.song_id != song_id:
                        raise AppError("request_conflict", "请求 ID 已用于其他歌曲", 409, old.id)
                    old = await self.get_playback(old.id)
                    if old.error_code:
                        raise AppError(
                            old.error_code,
                            old.error_message,
                            409,
                            old.id,
                            old.song_id,
                            old.error_code == "full_audio_unavailable",
                        )
                    return self.playback_view(old)
                song = await db.get(Song, song_id)
                if not song or song.verification_state != "available":
                    raise AppError(
                        "full_audio_unavailable",
                        "当前歌曲没有可确认的完整版，已暂时隐藏",
                        409,
                        song_id=song_id,
                        hidden=True,
                    )
                pb = Playback(
                    id=str(uuid4()),
                    song_id=song_id,
                    client_request_id=request_id,
                    expires_at=now() + timedelta(seconds=self.settings.playback_ttl),
                    play_source=None,
                    audio_kind="full",
                )
                db.add(pb)
                await db.execute(
                    update(SongStats)
                    .where(SongStats.song_id == song_id)
                    .values(
                        click_count=SongStats.click_count + 1,
                        first_clicked_at=func.coalesce(SongStats.first_clicked_at, now()),
                        last_clicked_at=now(),
                    )
                )
                await db.commit()
            resolving = False
            try:
                # Include time waiting for the same-song lock in the 30-second budget
                async with asyncio.timeout(self.settings.full_audio_verify_timeout):
                    async with self.locks.get(f"song:{song_id}"):
                        resolving = True
                        try:
                            preferred = (
                                Track(**song.verified_track) if song.verified_track else None
                            )
                            verified = await self._resolve_song(song, preferred=preferred)
                            pb = await self._save_playback(pb, verified)
                        except FullAudioUnavailable as exc:
                            await self.hide_song(song_id, exc)
                            await self.fail(pb.id, exc)
                            raise
            except AppError as exc:
                if exc.code == "service_busy":
                    async with self.db.sessions() as db:
                        current = await db.get(Playback, pb.id)
                        current.state, current.error_code, current.error_message = (
                            "failed",
                            exc.code,
                            exc.message,
                        )
                        await db.commit()
                    exc.playback_id = pb.id
                raise
            except TimeoutError:
                if not resolving:
                    exc = busy()
                    exc.playback_id = pb.id
                    async with self.db.sessions() as db:
                        current = await db.get(Playback, pb.id)
                        current.state, current.error_code, current.error_message = (
                            "failed",
                            exc.code,
                            exc.message,
                        )
                        await db.commit()
                    raise exc from None
                exc = FullAudioUnavailable(
                    "完整版获取超时，已暂时隐藏，冷却后自动重试", retryable=True
                )
                await self.hide_song(song_id, exc)
                await self.fail(pb.id, exc)
                raise exc from None
            return self.playback_view(pb)

    async def get_playback(self, playback_id):
        async with self.db.sessions() as db:
            pb = await db.get(Playback, playback_id)
            if not pb:
                raise AppError("playback_not_found", "播放会话不存在", 404, playback_id)
            if pb.expires_at <= now():
                raise AppError(
                    "playback_expired", "播放会话已过期，请重新选择歌曲", 410, playback_id
                )
            return pb

    async def fail(self, playback_id, exc):
        async with self.db.sessions() as db:
            pb = await db.get(Playback, playback_id)
            if pb:
                song_id = pb.song_id
                link = await db.get(AudioLink, pb.song_id)
                if link and link.version == pb.link_version:
                    link.last_error = exc.code
                # A terminal stream error must be distinguishable by the frontend
                if exc.code != "full_audio_unavailable":
                    exc.message = "当前完整版音频不可用，已暂时隐藏，稍后自动重新检查"
                    exc.code, exc.status = "full_audio_unavailable", 409
                pb.state, pb.error_code, pb.error_message = "failed", exc.code, exc.message
                await db.commit()
            else:
                song_id = None
        if song_id is not None and not exc.hidden:
            await self.hide_song(song_id, FullAudioUnavailable(exc.message, retryable=True))
        exc.playback_id, exc.song_id, exc.hidden = playback_id, song_id, True

    async def refresh(self, playback_id, expected_version):
        async with self.locks.get(f"playback:{playback_id}"):
            pb = await self.get_playback(playback_id)
            if pb.link_version != expected_version:
                return self.playback_view(pb)
            if pb.refresh_count >= 1:
                raise AppError(
                    "refresh_exhausted", "本次播放的刷新次数已用完，请重新点击歌曲播放", 409, pb.id
                )
            async with self.locks.get(f"song:{pb.song_id}"):
                async with self.db.sessions() as db:
                    current = await db.get(Playback, pb.id)
                    current.refresh_count += 1
                    current.state = "refreshing"
                    song = await db.get(Song, pb.song_id)
                    await db.commit()
                try:
                    preferred = Track(**pb.play_track) if pb.play_track else None
                    # During playback only refresh the chosen source, never switch sources
                    verified = await self.verifier.resolve(
                        track_of(song), preferred=preferred, only_preferred=True
                    )
                    return self.playback_view(await self._save_playback(pb, verified))
                except FullAudioUnavailable as exc:
                    await self.hide_song(song.id, exc)
                    await self.fail(pb.id, exc)
                    raise
                except AppError as exc:
                    if exc.code == "service_busy":
                        async with self.db.sessions() as db:
                            current = await db.get(Playback, pb.id)
                            current.refresh_count -= 1
                            current.state = pb.state
                            await db.commit()
                        exc.playback_id = pb.id
                    raise

    async def started(self, playback_id):
        async with self.locks.get(f"playback:{playback_id}"):
            pb = await self.get_playback(playback_id)
            if pb.state not in ("streaming", "playing"):
                raise AppError("not_streaming", "音频尚未成功传输，不能记录播放", 409, pb.id)
            if not pb.counted:
                async with self.db.sessions() as db:
                    await db.execute(
                        update(Playback)
                        .where(Playback.id == pb.id)
                        .values(counted=True, state="playing")
                    )
                    await db.execute(
                        update(SongStats)
                        .where(SongStats.song_id == pb.song_id)
                        .values(
                            listen_count=SongStats.listen_count + 1,
                            first_listened_at=func.coalesce(SongStats.first_listened_at, now()),
                            last_listened_at=now(),
                        )
                    )
                    await db.commit()
            return {"ok": True}

    async def stream_link(self, playback_id):
        async with self.locks.get(f"playback:{playback_id}"):
            pb = await self.get_playback(playback_id)
            if pb.state in ("failed", "resolving", "refreshing"):
                raise AppError(
                    pb.error_code or "not_ready", pb.error_message or "播放链接尚未就绪", 409, pb.id
                )
            if (
                not pb.audio_url
                or pb.audio_kind != "full"
                or not pb.play_source
                or not pb.play_track
                or not pb.audio_duration
            ):
                raise AppError("missing_link", "完整版播放链接不存在", 502, pb.id)
            link = AudioLink(
                song_id=pb.song_id,
                url=pb.audio_url,
                headers=pb.audio_headers or {},
                expires_at=pb.audio_expires_at,
                version=pb.link_version,
                audio_kind="full",
                last_error=None,
            )
            return pb, link

    async def streaming(self, playback_id):
        async with self.db.sessions() as db:
            await db.execute(
                update(Playback)
                .where(Playback.id == playback_id, Playback.state.in_(["ready", "streaming"]))
                .values(state="streaming", error_code=None, error_message=None)
            )
            await db.commit()

    async def note_stream_error(self, playback_id, exc):
        async with self.db.sessions() as db:
            current = await db.get(Playback, playback_id)
            if current:
                current.error_code, current.error_message = exc.code, exc.message
                await db.commit()
