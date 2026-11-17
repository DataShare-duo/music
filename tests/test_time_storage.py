import asyncio
from datetime import UTC, datetime, timedelta

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import select, text, update
from sqlalchemy.dialects import mysql
from sqlalchemy.orm import aliased

from music.app import migrate
from music.core.config import ROOT
from music.db.models import Base, ProviderCache, Song, SongStats, UserHistory
from music.db.session import Database
from music.db.time import (
    BEIJING,
    TIME_BITS,
    BeijingDateTime,
    UTCDateTime,
    first_time,
    mark_times,
    utc_expression,
)

INSTANT = datetime(2026, 11, 17, 4, 30, 15, 123456, tzinfo=UTC)


def test_storage_converts_any_aware_timezone_and_refuses_ambiguous_naive_time():
    kind = BeijingDateTime()
    assert kind.process_bind_param(INSTANT, None) == datetime(2026, 11, 17, 12, 30, 15, 123456)
    assert kind.process_bind_param(INSTANT.astimezone(BEIJING), None) == datetime(
        2026, 11, 17, 12, 30, 15, 123456
    )
    assert kind.process_bind_param(None, None) is None
    with pytest.raises(ValueError, match="时区"):
        kind.process_bind_param(INSTANT.replace(tzinfo=None), None)


def test_all_time_columns_use_beijing_storage_and_mysql_queries_compare_actual_instants():
    for table in Base.metadata.tables.values():
        times = [col for col in table.c if isinstance(col.type, UTCDateTime)]
        if not times:
            continue
        assert "time_storage_mask" in table.c
        assert all(isinstance(col.type, BeijingDateTime) and col.name in TIME_BITS for col in times)
    compiled = str(
        select(ProviderCache)
        .where(ProviderCache.expires_at > INSTANT)
        .compile(dialect=mysql.dialect())
    )
    assert "TIMESTAMPADD(HOUR, -8" in compiled
    assert "CASE WHEN" in compiled and "time_storage_mask" in compiled
    assert (
        str(
            select(UserHistory)
            .order_by(utc_expression(UserHistory.happened_at).desc())
            .compile(dialect=mysql.dialect())
        ).count("TIMESTAMPADD")
        >= 2
    )


async def test_legacy_and_new_time_storage_compare_sort_and_roundtrip_without_changing_raw_cells(
    tmp_path,
):
    db = Database(f"sqlite+aiosqlite:///{(tmp_path / 'time.db').as_posix()}")
    try:
        async with db.engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
            await conn.execute(
                text(
                    "INSERT INTO provider_cache (`key`,value,expires_at,updated_at,time_storage_mask) VALUES ('legacy','{}',:t,:t,0)"
                ),
                {"t": INSTANT.replace(tzinfo=None).isoformat(" ")},
            )
        async with db.sessions() as session:
            session.add(
                ProviderCache(
                    key="new", value={}, expires_at=INSTANT + timedelta(hours=1), updated_at=INSTANT
                )
            )
            await session.commit()
        async with db.sessions() as session:
            legacy = await session.get(ProviderCache, "legacy")
            new = await session.get(ProviderCache, "new")
            assert legacy.updated_at == new.updated_at == INSTANT
            assert new.expires_at.timestamp() == (INSTANT + timedelta(hours=1)).timestamp()
            valid = list(
                await session.scalars(
                    select(ProviderCache.key).where(
                        ProviderCache.expires_at > INSTANT + timedelta(seconds=1)
                    )
                )
            )
            assert valid == ["new"]
            # Despite the old UTC wall-clock appearing smaller, actual instant order wins.
            early = ProviderCache(
                key="early", value={}, expires_at=INSTANT - timedelta(minutes=1), updated_at=INSTANT
            )
            session.add(early)
            await session.commit()
            assert list(
                await session.scalars(
                    select(ProviderCache.key).order_by(utc_expression(ProviderCache.expires_at))
                )
            ) == ["early", "legacy", "new"]
            alias = aliased(ProviderCache)
            assert (
                await session.scalar(select(alias).where(alias.key == "new"))
            ).updated_at == INSTANT
            legacy.expires_at = INSTANT + timedelta(hours=2)
            await session.commit()
        async with db.engine.connect() as conn:
            rows = (
                (
                    await conn.execute(
                        text(
                            "SELECT `key`,updated_at,expires_at,time_storage_mask FROM provider_cache"
                        )
                    )
                )
                .mappings()
                .all()
            )
        rows = {r["key"]: r for r in rows}
        assert str(rows["legacy"]["updated_at"]) == "2026-11-17 04:30:15.123456"
        assert str(rows["legacy"]["expires_at"]) == "2026-11-17 14:30:15.123456"
        assert rows["legacy"]["time_storage_mask"] == TIME_BITS["expires_at"]
        assert str(rows["new"]["updated_at"]) == "2026-11-17 12:30:15.123456"
    finally:
        await db.engine.dispose()


async def test_upgrade_preserves_every_existing_timestamp_and_marks_only_future_cells(tmp_path):
    url = f"sqlite+aiosqlite:///{(tmp_path / 'old.db').as_posix()}"
    config = Config(str(ROOT / "alembic.ini"))
    config.set_main_option("script_location", str(ROOT / "migrations"))
    config.set_main_option("sqlalchemy.url", url)
    await asyncio.to_thread(command.upgrade, config, "0005")
    db = Database(url)
    try:
        async with db.engine.begin() as conn:
            await conn.execute(
                text(
                    "INSERT INTO provider_cache (`key`,value,expires_at,updated_at) VALUES ('old','{}',:t,:t)"
                ),
                {"t": INSTANT.replace(tzinfo=None).isoformat(" ")},
            )
            before = (await conn.execute(text("SELECT * FROM provider_cache"))).mappings().all()
        await asyncio.to_thread(migrate, url)
        await asyncio.to_thread(migrate, url)
        async with db.engine.connect() as conn:
            after = (await conn.execute(text("SELECT * FROM provider_cache"))).mappings().all()
        assert [{k: v for k, v in r.items() if k != "time_storage_mask"} for r in after] == before
        assert after[0]["time_storage_mask"] == 0
        async with db.sessions() as session:
            old = await session.get(ProviderCache, "old")
            assert old.updated_at == INSTANT
            old.expires_at = INSTANT + timedelta(minutes=15)
            await session.commit()
            assert old.time_storage_mask == TIME_BITS["expires_at"]
        with pytest.raises(RuntimeError, match="禁止"):
            await asyncio.to_thread(command.downgrade, config, "0005")
    finally:
        await db.engine.dispose()


async def test_conditional_statistics_keep_old_first_time_but_mark_new_last_time(tmp_path):
    db = Database(f"sqlite+aiosqlite:///{(tmp_path / 'stats.db').as_posix()}")
    try:
        async with db.engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        async with db.sessions() as session:
            song = Song(source="soda", source_track_id="1", title="test")
            session.add(song)
            await session.commit()
            sid = song.id
        async with db.engine.begin() as conn:
            await conn.execute(
                text(
                    "INSERT INTO song_stats(song_id,click_count,listen_count,first_clicked_at,time_storage_mask) VALUES (:id,2,0,:t,0)"
                ),
                {"id": sid, "t": INSTANT.replace(tzinfo=None).isoformat(" ")},
            )
        async with db.sessions() as session:
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
                        first_time(SongStats.first_clicked_at, INSTANT),
                    ),
                    ("last_clicked_at", INSTANT),
                )
            )
            await session.commit()
        async with db.engine.connect() as conn:
            row = (
                await conn.execute(
                    text(
                        "SELECT first_clicked_at,last_clicked_at,time_storage_mask FROM song_stats"
                    )
                )
            ).one()
        assert str(row[0]) == "2026-11-17 04:30:15.123456"
        assert str(row[1]) == "2026-11-17 12:30:15.123456"
        assert row[2] == TIME_BITS["last_clicked_at"]
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
                    ("first_listened_at", first_time(SongStats.first_listened_at, INSTANT)),
                    ("last_listened_at", INSTANT),
                )
            )
            await session.commit()
        async with db.engine.connect() as conn:
            first = (
                await conn.execute(text("SELECT first_listened_at FROM song_stats"))
            ).scalar_one()
            assert str(first) == "2026-11-17 12:30:15.123456"

    finally:
        await db.engine.dispose()


async def test_partial_upgrade_can_resume_without_resetting_existing_field_flags(tmp_path):
    url = f"sqlite+aiosqlite:///{(tmp_path / 'partial.db').as_posix()}"
    config = Config(str(ROOT / "alembic.ini"))
    config.set_main_option("script_location", str(ROOT / "migrations"))
    config.set_main_option("sqlalchemy.url", url)
    await asyncio.to_thread(command.upgrade, config, "0005")
    db = Database(url)
    try:
        async with db.engine.begin() as conn:
            await conn.execute(
                text("ALTER TABLE songs ADD COLUMN time_storage_mask INTEGER NOT NULL DEFAULT 0")
            )
        await asyncio.to_thread(migrate, url)
        await asyncio.to_thread(migrate, url)
        async with db.engine.connect() as conn:
            assert (
                await conn.execute(text("SELECT version_num FROM alembic_version"))
            ).scalar_one() == "0006"
    finally:
        await db.engine.dispose()


def test_offline_mysql_upgrade_adds_only_markers_and_never_rewrites_old_dates():
    from io import StringIO

    output = StringIO()
    config = Config(str(ROOT / "alembic.ini"), output_buffer=output)
    config.set_main_option("script_location", str(ROOT / "migrations"))
    config.set_main_option("sqlalchemy.url", "mysql+asyncmy://unused:unused@127.0.0.1/unused")
    command.upgrade(config, "0005:0006", sql=True)
    sql = output.getvalue()
    assert sql.count("ADD COLUMN time_storage_mask") == 9
    assert "DATE_ADD" not in sql and "TIMESTAMPADD" not in sql
    assert "DELETE FROM" not in sql and "TRUNCATE" not in sql
    assert "UPDATE songs" not in sql and "UPDATE users" not in sql


async def test_schema_guard_requires_markers_before_any_background_work(tmp_path):
    url = f"sqlite+aiosqlite:///{(tmp_path / 'schema.db').as_posix()}"
    config = Config(str(ROOT / "alembic.ini"))
    config.set_main_option("script_location", str(ROOT / "migrations"))
    config.set_main_option("sqlalchemy.url", url)
    await asyncio.to_thread(command.upgrade, config, "0005")
    db = Database(url)
    try:
        with pytest.raises(RuntimeError, match="0006"):
            await db.check_time_schema()
        await asyncio.to_thread(migrate, url)
        await db.check_time_schema()
    finally:
        await db.engine.dispose()
