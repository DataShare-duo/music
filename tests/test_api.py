import asyncio
from datetime import timedelta
from uuid import uuid4

import httpx
import pytest
from sqlalchemy import select, update

from music.app import create_app
from music.core.config import Settings
from music.core.errors import AppError
from music.db.models import Base, Playback, ProviderCache, Song, SongStats, now
from music.providers.official import ResolvedAudio, Track


class FakeProviders:
    providers = {"soda": True, "netease": True, "kuwo": True}

    def __init__(self):
        self.searches, self.resolutions = [], []
        self.search_error = self.resolve_error = False
        self.delay = 0
        self.active = self.max_active = 0

    async def search(self, source, query, page, size):
        self.searches.append((source, query, page))
        if self.search_error:
            raise AppError("upstream_timeout", "测试平台超时", 504)
        return [
            Track(
                source,
                str((page - 1) * size + i),
                f"测试歌曲 {i}",
                "测试歌手",
                "测试专辑",
                duration=90,
            )
            for i in range(size)
        ]

    async def resolve(self, source, track_id):
        self.resolutions.append((source, track_id))
        self.active += 1
        self.max_active = max(self.max_active, self.active)
        try:
            await asyncio.sleep(self.delay)
            if self.resolve_error:
                raise AppError("not_playable", "测试音频不可用")
            return ResolvedAudio(
                f"https://audio.example/{source}/{track_id}/{len(self.resolutions)}.mp3",
                {},
                "preview" if source == "soda" else "unknown",
            )
        finally:
            self.active -= 1


class FakeProbe:
    value = 90
    error = None

    def __init__(self):
        self.by_source = {}

    async def duration(self, audio, timeout=30):
        if self.error:
            raise AppError(self.error, "测试时长读取失败")
        return self.by_source.get(audio.url.split("/")[3], self.value)

    def close(self):
        pass


class FakeStream:
    def __init__(self, status=200, data=b"ID3test-audio", headers=None, fail=False):
        self.response = httpx.Response(
            status,
            headers=headers or {"content-type": "audio/mpeg", "content-length": str(len(data))},
        )
        self.closed = False

        async def chunks():
            yield data
            if fail:
                raise httpx.ReadError("broken")

        self.iterator = chunks()

    async def close(self):
        self.closed = True


class FakeProxy:
    def __init__(self):
        self.calls, self.streams, self.statuses = [], [], []
        self.custom_headers = None

    async def open(self, url, headers, range_header):
        self.calls.append((url, range_header))
        stream = FakeStream(
            self.statuses.pop(0) if self.statuses else 200, headers=self.custom_headers
        )
        self.streams.append(stream)
        return stream


@pytest.fixture
async def system(tmp_path):
    settings = Settings(
        database_url=f"sqlite+aiosqlite:///{(tmp_path / 'test.db').as_posix()}",
        frontend_dist=tmp_path / "dist",
        access_password="test-music-password-123",
        catalog_target=20,
        keywords=["热门"],
    )
    providers, proxy = FakeProviders(), FakeProxy()
    app = create_app(settings, providers, proxy, migrate_on_start=False, probe=FakeProbe())
    async with app.state.db.engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://test",
            auth=("music", "test-music-password-123"),
        ) as client:
            yield client, app.state.service, providers, proxy


async def song_id(client, service):
    response = await client.get("/api/search", params={"q": "test"})
    assert response.status_code == 200
    await service.wait_for_idle()
    response = await client.get("/api/search", params={"q": "test"})
    assert response.json()["items"], response.text
    service.providers.resolutions.clear()
    return response.json()["items"][0]["id"]


async def playback(client, id_, request_id=None):
    return await client.post(
        f"/api/songs/{id_}/playbacks", json={"client_request_id": request_id or str(uuid4())}
    )


async def test_search_is_background_only_verified_and_cached(system):
    client, service, providers, _ = system
    first = (await client.get("/api/search", params={"q": "test"})).json()
    assert first["items"] == [] and first["refreshing"]
    await service.wait_for_idle()
    data = (await client.get("/api/search", params={"q": "test"})).json()
    assert len(data["items"]) == data["verification_available"] == 20
    assert all(t["audio_kind"] == "full" for t in data["items"])
    assert "url" not in data["items"][0]
    assert len(providers.searches) == 1
    for params in ({"q": "test", "page": 2}, {"q": "test", "source": "netease"}):
        await client.get("/api/search", params=params)
    await service.wait_for_idle()
    assert len(providers.searches) == 3
    async with service.db.sessions() as db:
        songs = list(await db.scalars(select(Song)))
        assert len(songs) == 60 and all(t.created_at.tzinfo for t in songs)
        assert all(
            t.click_count == t.listen_count == 0 for t in await db.scalars(select(SongStats))
        )


async def test_search_stale_and_failure_cooldown(system):
    client, service, providers, _ = system
    await song_id(client, service)
    async with service.db.sessions() as db:
        cached = await db.scalar(select(ProviderCache))
        cached.expires_at = now() - timedelta(seconds=1)
        await db.commit()
    providers.search_error = True
    result = (await client.get("/api/search", params={"q": "test"})).json()
    assert result["stale"] and len(result["items"]) == 20
    await service.wait_for_idle()
    result = (await client.get("/api/search", params={"q": "test"})).json()
    assert result["stale"] and len(result["items"]) == 20
    assert len(providers.searches) == 2


async def test_empty_search_failure_and_invalid_query(system):
    client, service, providers, _ = system
    providers.search_error = True
    assert (await client.get("/api/search", params={"q": "none"})).status_code == 200
    await service.wait_for_idle()
    result = (await client.get("/api/search", params={"q": "none"})).json()
    assert result["items"] == [] and not result["refreshing"]
    assert len(providers.searches) == 1
    assert (await client.get("/api/search", params={"q": " "})).status_code == 400
    assert (
        await client.get("/api/search", params={"q": "x", "source": "invalid"})
    ).status_code == 400
    assert (await client.get("/api/search", params={"q": "x", "page": 0})).status_code == 422


async def test_home_cold_start_and_filtered_random_sample(system):
    client, service, providers, _ = system
    result = (await client.get("/api/home")).json()
    assert result["items"] == [] and result["refreshing"]
    await service.wait_for_idle()
    result = (await client.get("/api/home")).json()
    ids = [song["id"] for song in result["items"]]
    assert len(ids) == len(set(ids))
    assert ids and not result["refreshing"]
    searches = len(providers.searches)
    await client.get("/api/home")
    assert len(providers.searches) == searches


async def test_home_returns_100_only_after_verification(system):
    client, service, _, _ = system
    ids = await service.upsert_tracks(
        [Track("soda", str(i), f"歌曲 {i}", duration=90) for i in range(120)], recommended=True
    )
    await service.set_cache("catalog:soda", {}, 100)
    assert (await client.get("/api/home")).json()["items"] == []
    await service.enqueue(ids)
    await service.wait_for_idle()
    items = (await client.get("/api/home")).json()["items"]
    assert len(items) == len({song["id"] for song in items}) == 100


async def test_click_and_listen_separate_idempotent_and_actual_source(system):
    client, service, providers, proxy = system
    id_ = await song_id(client, service)
    request_id = str(uuid4())
    created = await playback(client, id_, request_id)
    assert created.status_code == 200, created.text
    pb = created.json()
    assert pb["play_source_name"] == "汽水音乐" and pb["audio_kind"] == "full"
    assert (await playback(client, id_, request_id)).json()["id"] == pb["id"]
    assert len(providers.resolutions) == 1
    assert (await client.post(f"/api/playbacks/{pb['id']}/started")).status_code == 409
    assert (await client.get(pb["stream_url"])).content == b"ID3test-audio"
    await asyncio.gather(*[client.post(f"/api/playbacks/{pb['id']}/started") for _ in range(4)])
    await client.get(pb["stream_url"])
    async with service.db.sessions() as db:
        stats = await db.get(SongStats, id_)
        assert (stats.click_count, stats.listen_count) == (1, 1)
        assert stats.first_clicked_at and stats.last_listened_at
    assert all(stream.closed for stream in proxy.streams)
    assert len(providers.resolutions) == 1


async def test_duplicate_click_concurrency_and_each_new_session_resolves(system):
    client, service, providers, _ = system
    id_ = await song_id(client, service)
    providers.delay = 0.02
    request_id = str(uuid4())
    replies = await asyncio.gather(*[playback(client, id_, request_id) for _ in range(4)])
    assert len({r.json()["id"] for r in replies}) == 1
    assert len(providers.resolutions) == 1
    await playback(client, id_)
    assert len(providers.resolutions) == 2
    async with service.db.sessions() as db:
        assert (await db.get(SongStats, id_)).click_count == 2


async def test_missing_or_unverified_song_rejected(system):
    client, service, _, _ = system
    id_ = (await service.upsert_tracks([Track("soda", "pending", "待验证", duration=90)]))[0]
    assert (await playback(client, id_)).json()["error"]["code"] == "full_audio_unavailable"
    assert (await playback(client, 99999)).status_code in (404, 409)


async def test_resolve_failure_hides_song_and_preserves_statistics(system):
    client, service, providers, _ = system
    id_ = await song_id(client, service)
    providers.resolve_error = True
    response = await playback(client, id_)
    error = response.json()["error"]
    assert error["code"] == "full_audio_unavailable" and error["hidden"] and error["song_id"] == id_
    assert error["playback_id"]
    async with service.db.sessions() as db:
        assert (await db.get(Song, id_)).verification_state == "unavailable"
        assert (await db.get(SongStats, id_)).click_count == 1
        assert (await db.get(SongStats, id_)).listen_count == 0
    assert id_ not in [
        song["id"]
        for song in (await client.get("/api/search", params={"q": "test"})).json()["items"]
    ]


async def test_expired_stream_refreshes_once_and_persists_version(system):
    client, service, providers, proxy = system
    id_ = await song_id(client, service)
    pb = (await playback(client, id_)).json()
    proxy.statuses = [403, 200]
    response = await client.get(pb["stream_url"])
    assert response.status_code == 200, response.text
    assert len(providers.resolutions) == 2
    current = (await client.get(f"/api/playbacks/{pb['id']}")).json()
    assert current["link_version"] == pb["link_version"] + 1 and current["refresh_count"] == 1
    assert (
        await client.post(
            f"/api/playbacks/{pb['id']}/refresh", json={"expected_version": pb["link_version"]}
        )
    ).status_code == 200
    exhausted = await client.post(
        f"/api/playbacks/{pb['id']}/refresh", json={"expected_version": current["link_version"]}
    )
    assert exhausted.status_code == 409
    assert exhausted.json()["error"]["code"] == "refresh_exhausted"
    assert not exhausted.json()["error"]["hidden"]
    async with service.db.sessions() as db:
        assert (await db.get(Song, id_)).verification_state == "available"
    assert all(stream.closed for stream in proxy.streams)


async def test_repeated_expiry_stops_no_preview_fallback(system):
    client, service, providers, proxy = system
    pb = (await playback(client, await song_id(client, service))).json()
    proxy.statuses = [404, 404]
    result = await client.get(pb["stream_url"])
    assert result.status_code in (409, 502)
    assert len(providers.resolutions) == 2
    assert (await client.get(f"/api/playbacks/{pb['id']}")).json()["state"] == "failed"
    assert all(stream.closed for stream in proxy.streams)


async def test_range_and_416_do_not_reresolve(system):
    client, service, providers, proxy = system
    pb = (await playback(client, await song_id(client, service))).json()
    proxy.statuses = [206, 416]
    proxy.custom_headers = {
        "content-type": "audio/mpeg",
        "content-range": "bytes 2-13/20",
        "accept-ranges": "bytes",
    }
    result = await client.get(pb["stream_url"], headers={"Range": "bytes=2-13"})
    assert result.status_code == 206 and result.headers["content-range"] == "bytes 2-13/20"
    assert proxy.calls[-1][1] == "bytes=2-13"
    assert (await client.get(pb["stream_url"], headers={"Range": "bytes=50-"})).status_code == 416
    assert len(providers.resolutions) == 1


async def test_non_audio_stops_and_session_expiry(system):
    client, service, providers, proxy = system
    pb = (await playback(client, await song_id(client, service))).json()
    proxy.custom_headers = {"content-type": "text/html"}
    assert (await client.get(pb["stream_url"])).status_code in (409, 502)
    assert len(providers.resolutions) == 2
    async with service.db.sessions() as db:
        current = await db.get(Playback, pb["id"])
        current.expires_at = now() - timedelta(seconds=1)
        await db.commit()
    assert (await client.get(f"/api/playbacks/{pb['id']}")).status_code == 410


async def test_sessions_have_immutable_source_snapshots(system):
    client, service, _, proxy = system
    id_ = await song_id(client, service)
    old = (await playback(client, id_)).json()
    async with service.db.sessions() as db:
        old_url = (await db.get(Playback, old["id"])).audio_url
    await playback(client, id_)
    await client.get(old["stream_url"])
    assert proxy.calls[-1][0] == old_url


async def test_disconnect_and_midstream_cleanup(system):
    from starlette.requests import ClientDisconnect

    from music.core.streaming import stream_audio

    client, service, _, proxy = system
    pb = (await playback(client, await song_id(client, service))).json()
    response = await stream_audio(service, proxy, pb["id"], None)

    async def receive():
        return {"type": "http.disconnect"}

    async def send(message):
        raise OSError("client gone")

    with pytest.raises(ClientDisconnect):
        await response({"type": "http", "asgi": {"spec_version": "2.4"}}, receive, send)
    assert proxy.streams[-1].closed

    async def broken(*args):
        stream = FakeStream(fail=True)
        proxy.streams.append(stream)
        return stream

    proxy.open = broken
    response = await stream_audio(service, proxy, pb["id"], None)
    assert await anext(response.body_iterator) == b"ID3test-audio"
    with pytest.raises(httpx.ReadError):
        await anext(response.body_iterator)
    assert proxy.streams[-1].closed


async def test_temporary_unavailable_recovers_when_official_promotes_full_audio(system):
    client, service, providers, _ = system
    service.probe.value = 60
    ids = await service.upsert_tracks(
        [Track("soda", "activity", "活动歌曲", "歌手", duration=240)], recommended=True
    )
    await service.enqueue(ids)
    await service.wait_for_idle()
    async with service.db.sessions() as db:
        song = await db.get(Song, ids[0])
        assert song.verification_state == "unavailable"
        assert 21590 < (song.next_check_at - now()).total_seconds() <= 21600
        song.next_check_at = now() - timedelta(seconds=1)
        await db.commit()
    assert await service.songs(ids) == []
    service.probe.value = 240
    providers.resolutions.clear()
    await service.scan_due()
    await service.wait_for_idle()
    assert (await service.songs(ids))[0].audio_kind == "full"
    assert providers.resolutions[0] == ("soda", "activity")
    async with service.db.sessions() as db:
        song = await db.get(Song, ids[0])
        assert song.verification_state == "available" and song.verification_error is None
        assert song.verified_track["source"] == "soda"
        assert (await db.get(SongStats, ids[0])).listen_count == 0


async def test_network_failure_short_cooldown_and_metadata_does_not_reset_state(system):
    _, service, _, _ = system
    ids = await service.upsert_tracks([Track("soda", "network", "网络歌曲", "歌手", duration=90)])
    service.probe.error = "probe_network_error"
    await service.enqueue(ids)
    await service.wait_for_idle()
    async with service.db.sessions() as db:
        song = await db.get(Song, ids[0])
        assert song.verification_state == "error"
        assert 55 < (song.next_check_at - now()).total_seconds() <= 60
    await service.upsert_tracks([Track("soda", "network", "网络歌曲", "歌手", duration=90)])
    async with service.db.sessions() as db:
        assert (await db.get(Song, ids[0])).verification_state == "error"


async def test_worker_deduplication_concurrency_and_startup_recovery(system):
    _, service, providers, _ = system
    ids = await service.upsert_tracks(
        [Track("soda", str(i), "歌曲", "歌手", duration=90) for i in range(8)]
    )
    providers.delay = 0.01
    await asyncio.gather(service.enqueue(ids), service.enqueue(ids), service.scan_due())
    await service.wait_for_idle()
    assert len(providers.resolutions) == len(ids) and providers.max_active <= 2
    async with service.db.sessions() as db:
        await db.execute(
            update(Song)
            .where(Song.id == ids[0])
            .values(verification_state="verifying", next_check_at=None)
        )
        await db.commit()
    # Restart the task runner on the same DB without dropping rows
    for task in [service.scan_task, *service.worker_tasks]:
        task.cancel()
    await asyncio.gather(service.scan_task, *service.worker_tasks, return_exceptions=True)
    await service.start()
    await service.wait_for_idle()
    assert (await service.songs(ids[:1]))[0].id == ids[0]


async def test_old_preview_session_is_rejected_even_with_valid_url(system):
    client, service, _, _ = system
    id_ = await song_id(client, service)
    pb = (await playback(client, id_)).json()
    async with service.db.sessions() as db:
        current = await db.get(Playback, pb["id"])
        current.audio_kind = "preview"
        await db.commit()
    assert (await client.get(pb["stream_url"])).status_code != 200


async def test_health_and_unknown_routes(system):
    client, _, _, _ = system
    assert (await client.get("/api/health")).json()["database"] == "ok"
    assert len((await client.get("/api/sources")).json()) == 3
    assert (await client.get("/api/nonexistent")).status_code == 404
    assert (await client.get("/")).status_code == 404


async def test_verified_fallback_source_reported_and_refresh_cannot_switch(system):
    client, service, providers, _ = system
    service.probe.by_source = {"soda": 60}
    id_ = await song_id(client, service)
    pb = (await playback(client, id_)).json()
    assert pb["play_source"] == "netease" and pb["play_source_name"] == "网易云音乐"
    response = await client.get("/api/search", params={"q": "test"})
    listed = next(item for item in response.json()["items"] if item["id"] == id_)
    assert listed["source"] == "soda"
    assert listed["play_source"] == "netease" and listed["play_source_name"] == "网易云音乐"
    assert providers.resolutions == [("netease", "0")]
    # Soda now has full audio, but an in-flight Netease session must not switch sources
    service.probe.by_source = {"netease": 60}
    providers.resolutions.clear()
    providers.searches.clear()
    result = await client.post(
        f"/api/playbacks/{pb['id']}/refresh", json={"expected_version": pb["link_version"]}
    )
    assert result.json()["error"]["code"] == "full_audio_unavailable"
    assert result.json()["error"]["hidden"]
    assert providers.resolutions == [("netease", "0")] and not providers.searches
    async with service.db.sessions() as db:
        assert (await db.get(Playback, pb["id"])).state == "failed"
        original = await db.get(Song, id_)
        assert original.source == "soda" and original.verification_state == "unavailable"
        original.next_check_at = now() - timedelta(seconds=1)
        await db.commit()
    # Only background recheck can restore the song using the newly available official source
    await service.scan_due()
    await service.wait_for_idle()
    items = (await client.get("/api/search", params={"q": "test"})).json()["items"]
    assert id_ in [item["id"] for item in items]
    restored = (await playback(client, id_)).json()
    assert restored["play_source_name"] == "汽水音乐"


async def test_home_poll_preserves_order_and_drops_hidden_rows(system):
    client, service, _, _ = system
    ids = await service.upsert_tracks(
        [Track("soda", str(i), f"歌曲 {i}", duration=90) for i in range(6)], recommended=True
    )
    await service.enqueue(ids)
    await service.wait_for_idle()
    await service.set_cache("catalog:soda", {}, 100)
    pinned = list(reversed(ids))
    response = await client.get("/api/home", params={"ids": ",".join(map(str, pinned))})
    assert [item["id"] for item in response.json()["items"]] == pinned
    async with service.db.sessions() as db:
        song = await db.get(Song, pinned[0])
        song.verification_state = "unavailable"
        song.next_check_at = now() + timedelta(hours=6)
        await db.commit()
    response = await client.get("/api/home", params={"ids": ",".join(map(str, pinned))})
    assert [item["id"] for item in response.json()["items"]] == pinned[1:]
    assert (await client.get("/api/home", params={"ids": "not-an-id"})).status_code == 400


async def test_foreground_budget_includes_lock_wait(system):
    client, service, providers, _ = system
    id_ = await song_id(client, service)
    service.settings.full_audio_verify_timeout = 0.02
    providers.delay = 0.2
    async with asyncio.timeout(1):
        responses = await asyncio.gather(playback(client, id_), playback(client, id_))
    assert all(
        response.json()["error"]["code"] in ("full_audio_unavailable", "service_busy")
        for response in responses
    )
    async with service.db.sessions() as db:
        assert (await db.get(SongStats, id_)).listen_count == 0


async def test_openapi_credits_project_author(system):
    client, _, _, _ = system
    info = (await client.get("/openapi.json")).json()["info"]
    assert info["contact"]["name"] == "DataShare"
    assert str(info["contact"]["url"]).rstrip("/") == "https://github.com/DataShare-duo/music"
