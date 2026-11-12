import asyncio
import base64
import threading
from datetime import timedelta

import httpx
import pytest
from sqlalchemy import select
from test_api import FakeStream, playback, song_id
from test_api import system as system

from music.core.access import MAX_BODY, AccessMiddleware, RateLimits
from music.core.config import Settings
from music.core.errors import AppError
from music.core.limits import BoundedExecutor
from music.db.models import Playback, ProviderCache, Song, SongStats, now
from music.providers.official import Track

PASSWORD = "test-music-password-123"


def settings(**kwargs):
    return Settings(_env_file=None, access_password=PASSWORD, **kwargs)


async def test_access_protects_pages_api_docs_and_audio(system):
    client, service, _, _ = system
    for path in (
        "/",
        "/api/home",
        "/api/search?q=x",
        "/api/playbacks/x/stream",
        "/docs",
        "/openapi.json",
    ):
        response = await client.get(path, auth=None)
        assert response.status_code == 401
        assert response.headers["www-authenticate"].startswith("Basic ")
        assert "no-store" in response.headers["cache-control"]
    assert not service.search_tasks
    assert service.catalog_task is None
    assert (await client.get("/api/sources", auth=("music", "wrong"))).status_code == 401
    assert (await client.get("/api/sources")).status_code == 200
    assert (await client.get("/api/health", auth=None)).status_code == 200
    folder = service.settings.frontend_dist
    folder.mkdir()
    (folder / "index.html").write_text("<h1>private</h1>", encoding="utf-8")
    response = await client.get("/")
    assert response.status_code == 200 and "private" in response.text
    assert response.headers["cache-control"] == "private, no-store"


async def test_no_password_fails_closed_but_health_works(system):
    client, service, _, _ = system
    service.settings.access_password = Settings(_env_file=None, access_password="").access_password
    assert (await client.get("/api/sources")).status_code == 503
    assert (await client.get("/api/health", auth=None)).status_code == 200
    assert not service.search_tasks


@pytest.mark.parametrize(
    "authorization",
    [
        "Bearer x",
        "Basic !!!",
        "Basic " + base64.b64encode(b"no-colon").decode(),
        "Basic " + "a" * 5000,
    ],
)
async def test_malformed_credentials_are_rejected(system, authorization):
    client, _, _, _ = system
    assert (
        await client.get("/api/sources", auth=None, headers={"Authorization": authorization})
    ).status_code == 401


async def test_cross_site_and_oversized_bodies_are_rejected(system):
    client, _, _, _ = system
    assert (
        await client.get("/api/sources", headers={"Sec-Fetch-Site": "cross-site"})
    ).status_code == 403
    assert (
        await client.post("/api/songs/1/playbacks", content=b"x" * (MAX_BODY + 1))
    ).status_code == 413

    async def chunks():
        yield b"x" * MAX_BODY
        yield b"x"

    assert (await client.post("/api/songs/1/playbacks", content=chunks())).status_code == 413
    assert (await client.get("/api/health")).status_code == 200


async def test_ip_rate_limit_does_not_trust_forwarded_header(system):
    client, service, _, _ = system
    service.settings.request_rate_per_minute = 2
    assert (
        await client.get("/api/sources", headers={"X-Forwarded-For": "1.1.1.1"})
    ).status_code == 200
    assert (
        await client.get("/api/sources", headers={"X-Forwarded-For": "8.8.8.8"})
    ).status_code == 200
    response = await client.get("/api/sources", headers={"X-Forwarded-For": "9.9.9.9"})
    assert response.status_code == 429 and response.headers["retry-after"]


async def test_authentication_and_action_rate_limits(system):
    client, service, _, _ = system
    for _ in range(10):
        assert (await client.get("/api/sources", auth=None)).status_code == 401
    assert (await client.get("/api/sources", auth=None)).status_code == 429
    assert (await client.get("/api/sources")).status_code == 200
    service.settings.action_rate_per_minute = 1
    assert (await playback(client, 9999)).status_code == 409
    assert (await playback(client, 9999)).status_code == 429


def test_rate_limit_tracking_is_bounded_and_expires(monkeypatch):
    import music.core.access as module

    clock = [100.0]
    monkeypatch.setattr(module.time, "monotonic", lambda: clock[0])
    limiter = RateLimits(max_keys=2)
    limiter.admit("a", 2)
    limiter.admit("b", 2)
    with pytest.raises(AppError):
        limiter.admit("c", 2)
    assert len(limiter.entries) == 2
    clock[0] += 61
    limiter.admit("c", 2)
    assert len(limiter.entries) == 1


async def test_search_admission_is_bounded_deduplicates_and_keeps_stale_cache(system):
    client, service, providers, _ = system
    await song_id(client, service)
    async with service.db.sessions() as db:
        cached = await db.scalar(select(ProviderCache).where(ProviderCache.key.like("search:%")))
        cached.expires_at = now() - timedelta(seconds=1)
        await db.commit()
    release = asyncio.Event()

    async def blocked(*args):
        await release.wait()
        return []

    providers.search = blocked
    service.settings.search_task_limit = 2
    try:
        assert (await client.get("/api/search?q=first")).status_code == 200
        assert (await client.get("/api/search?q=second")).status_code == 200
        response = await client.get("/api/search?q=third")
        assert response.status_code == 503 and response.headers["retry-after"]
        assert (await client.get("/api/search?q=first")).status_code == 200
        cached = (await client.get("/api/search?q=test")).json()
        assert cached["stale"] and cached["items"]
        assert len(service.search_tasks) == 2
    finally:
        release.set()
        await service.wait_for_idle()
    assert not service.search_tasks
    assert (await client.get("/api/search?q=third")).status_code == 200
    await service.wait_for_idle()


async def test_small_verification_queue_refills_without_losing_pending_songs(system):
    _, service, providers, _ = system
    for task in service.worker_tasks:
        task.cancel()
    await asyncio.gather(*service.worker_tasks, return_exceptions=True)
    service.queue = asyncio.Queue(maxsize=2)
    ids = await service.upsert_tracks(
        [Track("soda", str(i), "queue", duration=90) for i in range(9)]
    )
    await service.enqueue(ids)
    assert service.queue.qsize() == len(service.scheduled) == 2
    service.worker_tasks = [asyncio.create_task(service._worker()) for _ in range(2)]
    await service.wait_for_idle()
    assert len(await service.songs(ids)) == 9
    assert len(providers.resolutions) == 9
    assert not service.scheduled and service.queue.empty()
    async with service.db.sessions() as db:
        stats = list(await db.scalars(select(SongStats)))
        assert all(stat.click_count == stat.listen_count == 0 for stat in stats)


async def test_redundant_refresh_preserves_song_and_session(system):
    client, service, _, _ = system
    song = await song_id(client, service)
    pb = (await playback(client, song)).json()
    latest = (
        await client.post(
            f"/api/playbacks/{pb['id']}/refresh", json={"expected_version": pb["link_version"]}
        )
    ).json()
    response = await client.post(
        f"/api/playbacks/{pb['id']}/refresh", json={"expected_version": latest["link_version"]}
    )
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "refresh_exhausted"
    assert not response.json()["error"]["hidden"]
    assert (await client.get(latest["stream_url"])).status_code == 200
    async with service.db.sessions() as db:
        assert (await db.get(Song, song)).verification_state == "available"
        assert (await db.get(Playback, pb["id"])).state == "streaming"


async def test_busy_refresh_restores_quota_and_does_not_hide_song(system):
    client, service, providers, _ = system
    song = await song_id(client, service)
    pb = (await playback(client, song)).json()
    original = providers.resolve

    async def overloaded(*args):
        raise AppError("service_busy", "busy", 503)

    providers.resolve = overloaded
    response = await client.post(
        f"/api/playbacks/{pb['id']}/refresh", json={"expected_version": pb["link_version"]}
    )
    assert response.status_code == 503
    async with service.db.sessions() as db:
        current = await db.get(Playback, pb["id"])
        assert current.state == "ready" and current.refresh_count == 0
        assert (await db.get(Song, song)).verification_state == "available"
    response = await playback(client, song)
    assert response.status_code == 503 and not response.json()["error"]["hidden"]
    async with service.db.sessions() as db:
        assert (await db.get(Song, song)).verification_state == "available"
    providers.resolve = original
    assert (
        await client.post(
            f"/api/playbacks/{pb['id']}/refresh", json={"expected_version": pb["link_version"]}
        )
    ).status_code == 200


async def test_bounded_executor_holds_capacity_after_cancellation():
    executor = BoundedExecutor(1, 1, "test-bounded")
    release, entered = threading.Event(), asyncio.Event()
    loop = asyncio.get_running_loop()

    def blocking():
        loop.call_soon_threadsafe(entered.set)
        release.wait(timeout=5)
        return 1

    first = asyncio.create_task(executor.call(blocking))
    await entered.wait()
    second = asyncio.create_task(executor.call(lambda: 2))
    await asyncio.sleep(0)
    second.cancel()
    with pytest.raises(asyncio.CancelledError):
        await second
    try:
        with pytest.raises(AppError) as exc:
            await executor.call(lambda: 3)
        assert exc.value.code == "service_busy" and executor.capacity.active == 2
        first.cancel()
        with pytest.raises(asyncio.CancelledError):
            await first
        assert executor.capacity.active == 2
    finally:
        release.set()
        for _ in range(100):
            if not executor.capacity.active:
                break
            await asyncio.sleep(0.01)
        executor.close()
    assert executor.capacity.active == 0


@pytest.mark.parametrize("kind", ["global", "ip", "session", "request"])
async def test_stream_and_request_slots_release_on_disconnect(kind):
    entered, release = asyncio.Event(), asyncio.Event()
    calls = 0

    async def app(scope, receive, send):
        nonlocal calls
        calls += 1
        entered.set()
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await release.wait()
        await send({"type": "http.response.body", "body": b"audio"})

    config = settings(
        stream_concurrency=1 if kind == "global" else 6,
        stream_per_ip=1 if kind == "ip" else 3,
        stream_per_session=1 if kind == "session" else 2,
        request_concurrency=1,
    )
    middleware = AccessMiddleware(app, config)
    transport = httpx.ASGITransport(app=middleware)
    path = "/api/sources" if kind == "request" else "/api/playbacks/one/stream"
    other = path if kind in ("session", "request") else "/api/playbacks/two/stream"
    async with httpx.AsyncClient(
        transport=transport, base_url="http://test", auth=("music", PASSWORD)
    ) as client:
        task = asyncio.create_task(client.get(path))
        await entered.wait()
        try:
            response = await client.get(other)
            assert response.status_code == (503 if kind in ("global", "request") else 429)
            assert calls == 1
        finally:
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        assert middleware.streams.capacity.active == middleware.requests.active == 0
        assert not middleware.streams.ips and not middleware.streams.sessions
        release.set()
        assert (await client.get(path)).status_code == 200


@pytest.mark.parametrize("started", [True, False])
async def test_stream_timeout_releases_slots_without_appending_json(started):
    closed = asyncio.Event()

    async def app(scope, receive, send):
        try:
            if started:
                await send({"type": "http.response.start", "status": 200, "headers": []})
            await asyncio.Event().wait()
        finally:
            closed.set()

    config = settings()
    config.stream_max_seconds = 0.02
    middleware = AccessMiddleware(app, config)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=middleware),
        base_url="http://test",
        auth=("music", PASSWORD),
    ) as client:
        if started:
            with pytest.raises(TimeoutError):
                await client.get("/api/playbacks/one/stream")
        else:
            assert (await client.get("/api/playbacks/one/stream")).status_code == 504
    assert closed.is_set() and middleware.streams.capacity.active == 0


async def test_waiting_for_song_lock_does_not_hide_healthy_song(system):
    client, service, _, _ = system
    song = await song_id(client, service)
    service.settings.full_audio_verify_timeout = 0.02
    async with service.locks.get(f"song:{song}"):
        response = await playback(client, song)
    assert response.status_code == 503 and not response.json()["error"]["hidden"]
    async with service.db.sessions() as db:
        assert (await db.get(Song, song)).verification_state == "available"


async def test_stream_rejection_happens_before_upstream_and_disconnect_closes_connection(system):
    client, service, _, proxy = system
    song = await song_id(client, service)
    pb = (await playback(client, song)).json()
    service.settings.stream_per_session = 1
    opened, release = asyncio.Event(), asyncio.Event()
    original = proxy.open
    held = FakeStream()

    async def chunks():
        yield b"ID3test-audio"
        opened.set()
        await release.wait()

    held.iterator = chunks()

    async def open_held(*args):
        proxy.calls.append(args)
        return held

    proxy.open = open_held
    task = asyncio.create_task(client.get(pb["stream_url"]))
    await asyncio.wait_for(opened.wait(), 2)
    try:
        calls = len(proxy.calls)
        assert (await client.get(pb["stream_url"])).status_code == 429
        assert len(proxy.calls) == calls
    finally:
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        release.set()
        proxy.open = original
    assert held.closed
    assert (await client.get(pb["stream_url"])).status_code == 200


@pytest.mark.parametrize("password", ["short", "x" * 257])
def test_invalid_access_password_length_is_rejected(password):
    with pytest.raises(ValueError):
        Settings(_env_file=None, access_password=password)


async def test_background_saturation_preserves_previously_verified_song(system):
    _, service, providers, _ = system
    ids = await service.upsert_tracks([Track("soda", "busy-background", "verified", duration=90)])
    await service.enqueue(ids)
    await service.wait_for_idle()
    async with service.db.sessions() as db:
        song = await db.get(Song, ids[0])
        song.next_check_at = now() - timedelta(seconds=1)
        await db.commit()

    async def overloaded(*args):
        raise AppError("service_busy", "busy", 503)

    providers.resolve = overloaded
    await service.scan_due()
    await service.wait_for_idle()
    async with service.db.sessions() as db:
        song = await db.get(Song, ids[0])
        assert song.verification_state == "available"
        assert song.next_check_at > now()
    assert (await service.songs(ids))[0].id == ids[0]
