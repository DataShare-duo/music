import asyncio

from sqlalchemy import inspect, text

from music.app import migrate
from music.db.models import Base
from music.db.session import Database


async def test_alembic_upgrade_is_repeatable(tmp_path):
    url = f"sqlite+aiosqlite:///{(tmp_path / 'migrated.db').as_posix()}"
    await asyncio.to_thread(migrate, url)
    await asyncio.to_thread(migrate, url)
    db = Database(url)
    async with db.engine.connect() as connection:
        tables = await connection.run_sync(lambda sync: inspect(sync).get_table_names())
        assert set(Base.metadata.tables).issubset(tables)
        assert (
            await connection.execute(text("select version_num from alembic_version"))
        ).scalar_one() == "0003"
    await db.engine.dispose()


async def test_upgrade_preserves_legacy_song_statistics_and_blocks_old_preview(tmp_path):
    import sqlite3
    from datetime import UTC, datetime, timedelta

    from alembic import command
    from alembic.config import Config

    from music.core.config import ROOT
    from music.db.models import AudioLink, Playback, Song, SongStats

    path = tmp_path / "legacy.db"
    url = f"sqlite+aiosqlite:///{path.as_posix()}"
    config = Config(str(ROOT / "alembic.ini"))
    config.set_main_option("script_location", str(ROOT / "migrations"))
    config.set_main_option("sqlalchemy.url", url)
    await asyncio.to_thread(command.upgrade, config, "0001")
    created = datetime.now(UTC).replace(tzinfo=None).isoformat(" ")
    expires = (datetime.now(UTC) + timedelta(hours=1)).replace(tzinfo=None).isoformat(" ")
    with sqlite3.connect(path) as connection:
        connection.execute(
            "INSERT INTO songs (id,source,source_track_id,title,artist,album,cover_url,duration,recommended,created_at,updated_at) VALUES (1,'soda','legacy','旧歌曲','歌手','','',282,1,?,?)",
            (created, created),
        )
        connection.execute(
            "INSERT INTO song_stats (song_id,click_count,listen_count) VALUES (1,7,3)"
        )
        connection.execute(
            "INSERT INTO audio_links (song_id,url,headers,resolved_at,version,audio_kind) VALUES (1,'https://audio.example/preview','{}',?,1,'preview')",
            (created,),
        )
        connection.execute(
            "INSERT INTO playback_sessions (id,song_id,client_request_id,state,counted,refresh_count,link_version,audio_kind,created_at,expires_at) VALUES ('old',1,'legacy-request','ready',0,0,1,'preview',?,?)",
            (created, expires),
        )
    await asyncio.to_thread(migrate, url)
    db = Database(url)
    try:
        async with db.sessions() as session:
            song = await session.get(Song, 1)
            stats = await session.get(SongStats, 1)
            old = await session.get(Playback, "old")
            assert song.title == "旧歌曲" and song.verification_state == "pending"
            assert (stats.click_count, stats.listen_count) == (7, 3)
            assert song.verified_track is None and song.audio_duration is None
            assert old.state == "failed" and old.error_code == "full_audio_required"
            assert old.transport == "proxy"
            assert (await session.get(AudioLink, 1)).url == "https://audio.example/preview"
    finally:
        await db.engine.dispose()
