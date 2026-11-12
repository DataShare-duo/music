from __future__ import annotations

import asyncio
import logging
from collections import Counter
from dataclasses import asdict
from datetime import timedelta

from sqlalchemy import func, or_, select, update
from sqlalchemy.dialects.sqlite import insert

from music.core.errors import AppError
from music.core.locks import Locks
from music.core.verification import FullAudioResolver, FullAudioUnavailable
from music.db.models import AudioLink, Playback, ProviderCache, Song, SongStats, now
from music.providers.official import SOURCE_NAMES, Track, cover
from music.schemas.api import SongView

logger = logging.getLogger(__name__)


def track_of(song):
    return Track(
        song.source,
        song.source_track_id,
        song.title,
        song.artist,
        song.album,
        song.cover_url,
        song.duration,
    )


class CatalogService:
    def __init__(self, db, providers, settings, probe):
        self.db, self.providers, self.settings, self.probe = db, providers, settings, probe
        self.locks = Locks()
        self.verifier = FullAudioResolver(providers, probe, settings)
        self.catalog_task = None
        self.search_tasks = {}
        self.worker_tasks = []
        self.scan_task = None
        self.queue = asyncio.Queue(maxsize=settings.verification_queue_size)
        self.scheduled = set()
        self.closing = False

    async def start(self):
        self.closing = False
        async with self.db.sessions() as db:
            await db.execute(
                update(Song)
                .where(Song.verification_state == "verifying")
                .values(verification_state="pending")
            )
            await db.commit()
        self.worker_tasks = [
            asyncio.create_task(self._worker(), name=f"full-audio-worker-{i}")
            for i in range(self.settings.full_audio_verify_concurrency)
        ]
        await self.scan_due()
        self.scan_task = asyncio.create_task(self._scan_loop(), name="full-audio-recheck")

    async def close(self):
        self.closing = True
        tasks = [
            task
            for task in [
                self.catalog_task,
                self.scan_task,
                *self.worker_tasks,
                *self.search_tasks.values(),
            ]
            if task
        ]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        for component in (self.probe, self.providers):
            if close := getattr(component, "close", None):
                close()

    async def wait_for_idle(self):
        """Deterministic test hook: no sleeps needed for background catalog/search jobs"""
        while True:
            tasks = [
                t for t in [self.catalog_task, *self.search_tasks.values()] if t and not t.done()
            ]
            if tasks:
                await asyncio.gather(*tasks)
            await self.queue.join()
            if not any(not t.done() for t in self.search_tasks.values()) and (
                not self.catalog_task or self.catalog_task.done()
            ):
                return

    async def _scan_loop(self):
        while True:
            await asyncio.sleep(60)
            try:
                await self.scan_due()
            except Exception:
                logger.exception("Full-audio recheck scan failed")

    async def scan_due(self):
        room = self.queue.maxsize - self.queue.qsize()
        if self.closing or room <= 0:
            return
        async with self.db.sessions() as db:
            ids = list(
                await db.scalars(
                    select(Song.id)
                    .where(or_(Song.verification_state == "pending", Song.next_check_at <= now()))
                    .where(Song.id.not_in(self.scheduled))
                    .order_by(Song.next_check_at, Song.id)
                    .limit(room)
                )
            )
        await self.enqueue(ids)

    async def enqueue(self, ids):
        if self.closing or not ids:
            return
        async with self.locks.get("verification-queue"):
            room = self.queue.maxsize - self.queue.qsize()
            if room <= 0:
                return  # Persisted pending rows are picked up on the next refill/scan
            async with self.db.sessions() as db:
                songs = list(
                    await db.scalars(
                        select(Song)
                        .where(
                            Song.id.in_(ids),
                            Song.id.not_in(self.scheduled),
                            or_(Song.verification_state == "pending", Song.next_check_at <= now()),
                        )
                        .order_by(Song.next_check_at, Song.id)
                        .limit(room)
                    )
                )
                scheduled = []
                for song in songs:
                    if song.id in self.scheduled:
                        continue
                    due = song.verification_state == "pending" or (
                        song.next_check_at and song.next_check_at <= now()
                    )
                    if not due:
                        continue
                    if song.verification_state != "available":
                        song.verification_state = "pending"
                    scheduled.append(song.id)
                await db.commit()
            for song_id in scheduled:
                self.scheduled.add(song_id)
                self.queue.put_nowait(song_id)

    async def _worker(self):
        while True:
            song_id = await self.queue.get()
            try:
                async with self.locks.get(f"song:{song_id}"):
                    async with self.db.sessions() as db:
                        song = await db.get(Song, song_id)
                        if not song or (
                            song.verification_state == "available"
                            and song.next_check_at
                            and song.next_check_at > now()
                        ):
                            continue
                        previous_state = song.verification_state
                        song.verification_state = "verifying"
                        await db.commit()
                    try:
                        # Rechecks always start with the original (Soda) official source
                        result = await self.verifier.resolve(track_of(song))
                        await self.save_verified(song_id, result)
                    except FullAudioUnavailable as exc:
                        await self.hide_song(song_id, exc)
                    except AppError as exc:
                        if exc.code != "service_busy":
                            raise
                        # Local saturation is not evidence that the song is unavailable
                        async with self.db.sessions() as db:
                            current = await db.get(Song, song_id)
                            current.verification_state = (
                                "available" if previous_state == "available" else "error"
                            )
                            current.next_check_at = now() + timedelta(
                                seconds=self.settings.failure_cooldown
                            )
                            await db.commit()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("Full-audio verification failed for song %s", song_id)
                await self.hide_song(
                    song_id, FullAudioUnavailable("音频验证异常，稍后自动重试", retryable=True)
                )
            finally:
                self.scheduled.discard(song_id)
                try:
                    if not asyncio.current_task().cancelling():
                        await self.scan_due()
                except Exception:
                    logger.exception("Verification queue refill failed")
                finally:
                    self.queue.task_done()

    async def save_verified(self, song_id, result, playback_id=None):
        metadata = asdict(result.track)
        async with self.db.sessions() as db:
            song = await db.get(Song, song_id)
            song.verification_state, song.verification_error = "available", None
            song.checked_at = now()
            song.next_check_at = now() + timedelta(
                seconds=self.settings.full_audio_recheck_interval
            )
            song.verified_track, song.audio_duration = metadata, result.duration
            link = await db.get(AudioLink, song_id)
            if not link:
                link = AudioLink(song_id=song_id, url=result.audio.url, version=1)
                db.add(link)
            else:
                link.version += 1
            link.url, link.headers = result.audio.url, result.audio.headers
            link.resolved_at, link.expires_at, link.last_error = (
                now(),
                result.audio.expires_at,
                None,
            )
            link.audio_kind, link.play_source = "full", result.track.source
            link.play_track, link.audio_duration = metadata, result.duration
            if playback_id:
                pb = await db.get(Playback, playback_id)
                pb.link_version, pb.audio_kind, pb.state = link.version, "full", "ready"
                pb.play_source, pb.play_track, pb.audio_duration = (
                    result.track.source,
                    metadata,
                    result.duration,
                )
                # Session snapshots prevent concurrent sessions from silently changing sources
                pb.audio_url, pb.audio_headers, pb.audio_expires_at = (
                    result.audio.url,
                    result.audio.headers,
                    result.audio.expires_at,
                )
                pb.error_code = pb.error_message = None
            await db.commit()

    async def hide_song(self, song_id, exc):
        retry = (
            self.settings.failure_cooldown
            if exc.retryable
            else self.settings.full_audio_recheck_interval
        )
        async with self.db.sessions() as db:
            song = await db.get(Song, song_id)
            if not song:
                return
            song.verification_state = "error" if exc.retryable else "unavailable"
            song.verification_error = exc.message
            song.checked_at, song.next_check_at = now(), now() + timedelta(seconds=retry)
            await db.commit()
        exc.song_id, exc.hidden = song_id, True

    async def upsert_tracks(self, tracks, recommended=False):
        ids = []
        async with self.db.sessions() as db:
            for track in tracks:
                if not track.title or not track.source_track_id:
                    continue
                values = asdict(track)
                values.update(recommended=recommended, updated_at=now())
                statement = insert(Song).values(**values)
                changes = {
                    key: getattr(statement.excluded, key)
                    for key in values
                    if key not in ("recommended", "source", "source_track_id")
                }
                if recommended:
                    changes["recommended"] = True
                song_id = (
                    await db.execute(
                        statement.on_conflict_do_update(
                            index_elements=["source", "source_track_id"], set_=changes
                        ).returning(Song.id)
                    )
                ).scalar_one()
                await db.execute(insert(SongStats).values(song_id=song_id).on_conflict_do_nothing())
                ids.append(song_id)
            await db.commit()
        return list(dict.fromkeys(ids))

    async def songs(self, ids=None, home=False):
        async with self.db.sessions() as db:
            query = (
                select(Song, SongStats)
                .join(SongStats)
                .where(
                    Song.verification_state == "available",
                    Song.verified_track.is_not(None),
                    Song.audio_duration > 0,
                )
            )
            if home:
                query = (
                    query.where(Song.recommended.is_(True), Song.source == "soda")
                    .order_by(func.random())
                    .limit(100)
                )
            elif ids is not None:
                query = query.where(Song.id.in_(ids))
            result = []
            for song, stats in (await db.execute(query)).all():
                view = SongView.model_validate(song)
                view.cover_url, view.audio_kind = cover(view.cover_url), "full"
                view.play_source = (song.verified_track or {}).get("source")
                view.play_source_name = (
                    SOURCE_NAMES.get(view.play_source, view.play_source)
                    if view.play_source
                    else None
                )
                for key in ("click_count", "listen_count", "last_clicked_at", "last_listened_at"):
                    setattr(view, key, getattr(stats, key))
                result.append(view)
            if ids is not None and not home:
                order = {id_: index for index, id_ in enumerate(ids)}
                result.sort(key=lambda t: order[t.id])
            return result

    async def progress(self, ids=None, home=False):
        async with self.db.sessions() as db:
            query = select(Song.verification_state, func.count()).group_by(Song.verification_state)
            if home:
                query = query.where(Song.recommended.is_(True), Song.source == "soda")
            elif ids is not None:
                query = query.where(Song.id.in_(ids))
            counts = Counter(dict((await db.execute(query)).all()))
        return {
            "verification_total": sum(counts.values()),
            "verification_pending": counts["pending"] + counts["verifying"],
            "verification_available": counts["available"],
            "verification_unavailable": counts["unavailable"],
            "verification_errors": counts["error"],
        }

    async def cache(self, key):
        async with self.db.sessions() as db:
            return await db.get(ProviderCache, key)

    async def set_cache(self, key, value, ttl):
        async with self.db.sessions() as db:
            statement = insert(ProviderCache).values(
                key=key, value=value, expires_at=now() + timedelta(seconds=ttl), updated_at=now()
            )
            await db.execute(
                statement.on_conflict_do_update(
                    index_elements=["key"],
                    set_={
                        "value": statement.excluded.value,
                        "expires_at": statement.excluded.expires_at,
                        "updated_at": statement.excluded.updated_at,
                    },
                )
            )
            await db.commit()
