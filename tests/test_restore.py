import asyncio

from sqlalchemy import select
from test_api import system as system

from music.db.models import Song, SongStats
from music.providers.official import Track


async def test_restore_requires_exact_platform_id_and_never_trusts_client_duration(system):
    client, service, providers, _ = system
    response = await client.post(
        "/api/miniprogram/songs/restore",
        json={
            "source": "soda",
            "source_track_id": "3",
            "query_hint": "歌曲",
        },
    )
    assert response.status_code == 200, response.text
    await service.wait_for_idle()
    response = await client.post(
        "/api/miniprogram/songs/restore",
        json={
            "source": "soda",
            "source_track_id": "3",
            "query_hint": "歌曲",
        },
    )
    assert response.json()["status"] == "available"
    assert response.json()["song"]["source_track_id"] == "3"
    assert "audio_url" not in response.text
    async with service.db.sessions() as db:
        stats = await db.get(SongStats, response.json()["song"]["id"])
        assert stats.click_count == stats.listen_count == 0
    invalid = await client.post(
        "/api/miniprogram/songs/restore",
        json={
            "source": "soda",
            "source_track_id": "3",
            "query_hint": "歌曲",
            "duration": 30,
        },
    )
    assert invalid.status_code == 422


async def test_restore_rejects_wrong_id_and_cools_misses(system):
    client, service, providers, _ = system
    body = {"source": "soda", "source_track_id": "not-the-same-id", "query_hint": "歌曲"}
    result = await client.post("/api/miniprogram/songs/restore", json=body)
    assert result.json()["status"] == "unavailable"
    count = len(providers.searches)
    assert (await client.post("/api/miniprogram/songs/restore", json=body)).json()["song"] is None
    assert len(providers.searches) == count


async def test_restore_merges_concurrent_metadata_work_and_existing_song_does_not_search(system):
    client, service, providers, _ = system
    await service.upsert_tracks([Track("kuwo", "stable", "原歌", "歌手", duration=90)])
    body = {"source": "kuwo", "source_track_id": "stable", "query_hint": "不可信的不同歌名"}
    results = await asyncio.gather(
        *[client.post("/api/miniprogram/songs/restore", json=body) for _ in range(4)]
    )
    assert all(r.status_code == 200 for r in results)
    assert not providers.searches
    async with service.db.sessions() as db:
        song = await db.scalar(select(Song).where(Song.source_track_id == "stable"))
        assert song.title == "原歌"


async def test_restore_input_validation(system):
    client, _, _, _ = system
    for changes in (
        {"source": "http://localhost"},
        {"source_track_id": "../x"},
        {"query_hint": " "},
        {"query_hint": "x" * 101},
    ):
        body = {"source": "soda", "source_track_id": "3", "query_hint": "歌曲"} | changes
        assert (await client.post("/api/miniprogram/songs/restore", json=body)).status_code in (
            400,
            422,
        )


async def test_shared_autoplay_counts_only_after_real_started_and_is_idempotent(system):
    from uuid import uuid4

    from test_api import song_id

    client, service, _, _ = system
    id_ = await song_id(client, service)
    request_id = str(uuid4())
    body = {"client_request_id": request_id, "defer_click": True}
    pb = (await client.post(f"/api/miniprogram/songs/{id_}/playbacks", json=body)).json()
    async with service.db.sessions() as db:
        stats = await db.get(SongStats, id_)
        assert stats.click_count == stats.listen_count == 0
    repeated = await client.post(f"/api/miniprogram/songs/{id_}/playbacks", json=body)
    assert repeated.json()["id"] == pb["id"]
    await asyncio.gather(
        *[client.post(f"/api/miniprogram/playbacks/{pb['id']}/started") for _ in range(3)]
    )
    async with service.db.sessions() as db:
        stats = await db.get(SongStats, id_)
        assert stats.click_count == stats.listen_count == 1
