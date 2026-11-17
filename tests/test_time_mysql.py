"""Opt-in real MySQL regression. A loopback, pre-created scratch database only."""

import asyncio
import os
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import DateTime, MetaData, select, text, update
from sqlalchemy.dialects.mysql import insert
from sqlalchemy.engine import make_url

from music.app import migrate
from music.core.config import ROOT
from music.db.models import Base, ProviderCache, Song, SongStats
from music.db.session import Database
from music.db.time import TIME_BITS, first_time, mark_times
from music.personal import PersonalService

URL = os.getenv("MUSIC_TEST_LOCAL_MYSQL_URL", "")
pytestmark = pytest.mark.skipif(not URL, reason="requires an isolated local MySQL scratch database")


async def test_real_mysql_legacy_cells_untouched_new_cells_beijing_and_mixed_updates(monkeypatch):
    monkeypatch.delenv("MUSIC_MIGRATION_DATABASE_URL", raising=False)
    url = make_url(URL)
    assert url.host in {"127.0.0.1", "localhost"} and url.database.startswith("music_time_test_")
    config = Config(str(ROOT / "alembic.ini"))
    config.set_main_option("script_location", str(ROOT / "migrations"))
    config.set_main_option("sqlalchemy.url", URL)
    await asyncio.to_thread(command.upgrade, config, "0005")
    db = Database(URL)
    instant = datetime(2026, 11, 17, 4, 30, 15, tzinfo=UTC)
    try:
        async with db.engine.begin() as conn:
            assert (await conn.execute(text("SELECT @@session.time_zone"))).scalar_one() == "+08:00"
            metadata = MetaData()
            await conn.run_sync(metadata.reflect)
            rows = {
                "songs": {
                    "id": 1,
                    "source": "soda",
                    "source_track_id": "legacy",
                    "title": "old",
                    "artist": "a",
                    "album": "",
                    "cover_url": "",
                    "duration": 0,
                    "recommended": False,
                    "verification_state": "available",
                },
                "song_stats": {"song_id": 1, "click_count": 2, "listen_count": 1},
                "audio_links": {
                    "song_id": 1,
                    "url": "https://audio.example/old",
                    "headers": {},
                    "version": 1,
                    "audio_kind": "full",
                },
                "playback_sessions": {
                    "id": "old",
                    "song_id": 1,
                    "client_request_id": "old",
                    "transport": "direct",
                    "state": "ready",
                    "counted": False,
                    "refresh_count": 0,
                    "link_version": 1,
                    "audio_kind": "full",
                    "click_pending": False,
                },
                "provider_cache": {"key": "legacy", "value": {}},
                "users": {"user_key": "c" * 64, "app_id": "wx-test", "revision": 0},
                "user_marks": {
                    "user_key": "c" * 64,
                    "kind": "favorite",
                    "source": "soda",
                    "source_track_id": "legacy",
                    "title": "old",
                    "artist": "a",
                    "album": "",
                    "cover_url": "",
                    "duration": 0,
                },
                "user_history_state": {"user_key": "c" * 64, "kind": "recent", "epoch": 0},
                "user_history": {
                    "user_key": "c" * 64,
                    "kind": "recent",
                    "history_key": "soda:legacy",
                },
                "user_operations": {"user_key": "c" * 64, "kind": "recent", "operation_id": "old"},
            }
            before = {}
            for name, values in rows.items():
                table = metadata.tables[name]
                for col in table.c:
                    if isinstance(col.type, DateTime):
                        values[col.name] = instant.replace(tzinfo=None)
                await conn.execute(table.insert().values(**values))
                before[name] = (await conn.execute(text("SELECT * FROM " + name))).mappings().all()
        await asyncio.to_thread(migrate, URL)
        async with db.engine.connect() as conn:
            for name, original in before.items():
                after = (await conn.execute(text("SELECT * FROM " + name))).mappings().all()
                assert [
                    {k: v for k, v in r.items() if k != "time_storage_mask"} for r in after
                ] == original
                if name != "user_history_state":
                    assert all(row["time_storage_mask"] == 0 for row in after)
        async with db.sessions() as session:
            session.add(
                ProviderCache(
                    key="fresh",
                    value={},
                    expires_at=instant + timedelta(hours=1),
                    updated_at=instant,
                )
            )
            song = Song(source="soda", source_track_id=str(uuid4()), title="time test")
            session.add(song)
            await session.commit()
            sid = song.id
        async with db.engine.begin() as conn:
            await conn.execute(
                text(
                    "INSERT INTO song_stats(song_id,click_count,listen_count,first_clicked_at,time_storage_mask) VALUES (:id,2,0,:t,0)"
                ),
                {"id": sid, "t": instant.replace(tzinfo=None)},
            )
        async with db.sessions() as session:
            assert (await session.get(ProviderCache, "fresh")).updated_at == instant
            assert list(
                await session.scalars(
                    select(ProviderCache.key).where(
                        ProviderCache.expires_at > instant + timedelta(seconds=1)
                    )
                )
            ) == ["fresh"]
            await session.execute(
                update(SongStats)
                .where(SongStats.song_id == sid)
                .ordered_values(
                    (
                        "time_storage_mask",
                        mark_times(
                            SongStats, "last_clicked_at", first_if_null=("first_clicked_at",)
                        ),
                    ),
                    (
                        "first_clicked_at",
                        first_time(SongStats.first_clicked_at, instant),
                    ),
                    ("last_clicked_at", instant),
                )
            )
            old = await session.get(ProviderCache, "legacy")
            old.expires_at = instant + timedelta(hours=2)
            await session.commit()
        async with db.engine.connect() as conn:
            row = (
                await conn.execute(
                    text(
                        "SELECT first_clicked_at,last_clicked_at,time_storage_mask FROM song_stats WHERE song_id=:id"
                    ),
                    {"id": sid},
                )
            ).one()
            assert row[0] == instant.replace(tzinfo=None)
            assert row[1] == instant.replace(tzinfo=None) + timedelta(hours=8)
            assert row[2] == TIME_BITS["last_clicked_at"]
            fresh = (
                await conn.execute(
                    text("SELECT updated_at FROM provider_cache WHERE `key`='fresh'")
                )
            ).scalar_one()
            assert fresh == instant.replace(tzinfo=None) + timedelta(hours=8)
            old = (
                await conn.execute(
                    text("SELECT updated_at,expires_at FROM provider_cache WHERE `key`='legacy'")
                )
            ).one()
            assert old[0] == instant.replace(tzinfo=None)
            assert old[1] == instant.replace(tzinfo=None) + timedelta(hours=10)
        async with db.sessions() as session:
            await session.execute(
                update(SongStats)
                .where(SongStats.song_id == sid)
                .ordered_values(
                    (
                        "time_storage_mask",
                        mark_times(
                            SongStats, "last_listened_at", first_if_null=("first_listened_at",)
                        ),
                    ),
                    ("first_listened_at", first_time(SongStats.first_listened_at, instant)),
                    ("last_listened_at", instant),
                )
            )
            await session.commit()
        async with db.engine.connect() as conn:
            stats = (
                await conn.execute(
                    text(
                        "SELECT first_clicked_at,first_listened_at,last_listened_at FROM song_stats WHERE song_id=:id"
                    ),
                    {"id": sid},
                )
            ).one()
            assert stats[0] == instant.replace(tzinfo=None)
            assert stats[1] == stats[2] == instant.replace(tzinfo=None) + timedelta(hours=8)
        # MySQL VALUES(column) and conditional UPSERT must not reconvert existing cells.
        async with db.sessions() as session:
            statement = insert(ProviderCache).values(
                key="legacy",
                value={},
                updated_at=instant,
                expires_at=instant + timedelta(minutes=10),
            )
            await session.execute(
                statement.on_duplicate_key_update(
                    time_storage_mask=mark_times(ProviderCache, "updated_at", "expires_at"),
                    updated_at=statement.inserted.updated_at,
                    expires_at=statement.inserted.expires_at,
                )
            )
            await session.commit()
            assert (await session.get(ProviderCache, "legacy")).updated_at == instant
        async with db.engine.connect() as conn:
            raw = (
                await conn.execute(
                    text("SELECT updated_at FROM provider_cache WHERE `key`='legacy'")
                )
            ).scalar_one()
            assert raw == instant.replace(tzinfo=None) + timedelta(hours=8)
        personal = PersonalService(db)
        await personal.handle("profile.enable", {}, "a" * 64, "wx-test")
        response = await personal.handle(
            "history.sync",
            {
                "kind": "recent",
                "epoch": 0,
                "ops": [
                    {
                        "id": "mysql-time-event",
                        "type": "put",
                        "at": instant.timestamp() * 1000,
                        "song": {
                            "source": "soda",
                            "source_track_id": "1",
                            "title": "t",
                            "artist": "a",
                        },
                    }
                ],
            },
            "a" * 64,
            "wx-test",
        )
        assert response["recent"]["items"][0]["at"] == instant.timestamp() * 1000
        async with db.engine.connect() as conn:
            assert (
                await conn.execute(
                    text("SELECT happened_at FROM user_history WHERE user_key='" + "a" * 64 + "'")
                )
            ).scalar_one() == instant.replace(tzinfo=None) + timedelta(hours=8)
        # Real schema matches all time-capable models, without changing unrelated tables.
        assert all(
            "time_storage_mask" in table.c
            for table in Base.metadata.tables.values()
            if table.name != "user_history_state"
        )
    finally:
        await db.engine.dispose()
