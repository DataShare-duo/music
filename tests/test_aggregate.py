import asyncio
from datetime import timedelta
from unittest.mock import AsyncMock

from sqlalchemy import select
from test_api import system as system

from music.core.errors import AppError
from music.db.models import ProviderCache, Song, now
from music.providers.official import SOURCE_NAMES


async def test_default_search_queries_all_sources_without_audio_resolution_and_is_bounded(system):
    client, service, providers, _ = system
    service.enqueue = AsyncMock()
    calls, active, peak = [], 0, 0
    original = providers.search

    async def search(source, query, page, size):
        nonlocal active, peak
        calls.append((source, page, size))
        active += 1
        peak = max(peak, active)
        try:
            await asyncio.sleep(0.01)
            return await original(source, query, page, size)
        finally:
            active -= 1

    providers.search = search
    response = await client.get("/api/search", params={"q": "多源"})
    assert response.status_code == 200 and response.json()["refreshing"]
    await service.wait_for_idle()
    result = (await client.get("/api/search", params={"q": "多源"})).json()
    assert {source for source, _, _ in calls} == set(SOURCE_NAMES)
    assert all(page == 1 and size == 4 for _, page, size in calls)
    assert peak <= min(2, service.settings.provider_concurrency)
    assert len(result["search_sources"]) == 5
    assert all(row["status"] == "ok" for row in result["search_sources"])
    assert not providers.resolutions
    assert result["items"] == []  # Metadata cannot bypass full-audio validation.


async def test_aggregate_pages_are_real_disjoint_twenty_candidate_pages_and_cache_hits_do_not_refetch(
    system,
):
    client, service, providers, _ = system

    async def page(number):
        await client.get("/api/search", params={"q": "分页", "page": number})
        await service.wait_for_idle()
        return (await client.get("/api/search", params={"q": "分页", "page": number})).json()

    one, two = await page(1), await page(2)
    assert len(one["items"]) == len(two["items"]) == 20
    assert {row["source"] for row in one["items"]} == set(SOURCE_NAMES)
    assert not {row["id"] for row in one["items"]} & {row["id"] for row in two["items"]}
    count = len(providers.searches)
    await client.get("/api/search", params={"q": "分页", "page": 1})
    assert len(providers.searches) == count
    assert one["has_more"] and all(row["audio_kind"] == "full" for row in one["items"])


async def test_one_broken_source_keeps_other_results_and_only_its_own_old_candidates(system):
    client, service, providers, _ = system
    await client.get("/api/search", params={"q": "旧缓存"})
    await service.wait_for_idle()
    previous = (await client.get("/api/search", params={"q": "旧缓存"})).json()
    async with service.db.sessions() as db:
        cache = await db.scalar(select(ProviderCache).where(ProviderCache.key.like("search:%")))
        cache.expires_at = now() - timedelta(seconds=1)
        await db.commit()
    original = providers.search

    async def search(source, *args):
        if source == "soda":
            raise AppError("upstream_timeout", "timeout", 504)
        return await original(source, *args)

    providers.search = search
    await client.get("/api/search", params={"q": "旧缓存"})
    await service.wait_for_idle()
    result = (await client.get("/api/search", params={"q": "旧缓存"})).json()
    assert result["stale"] and len(result["items"]) == 20
    soda = next(row for row in result["search_sources"] if row["source"] == "soda")
    assert soda["status"] == "error" and soda["stale"]
    assert {row["id"] for row in result["items"] if row["source"] == "soda"} == {
        row["id"] for row in previous["items"] if row["source"] == "soda"
    }
    assert all(row["status"] == "ok" for row in result["search_sources"] if row["source"] != "soda")


async def test_home_refill_is_debounced_and_advances_cursor_after_empty_candidates(system):
    client, service, providers, _ = system

    async def empty(source, query, page, size):
        providers.searches.append((source, query, page))
        return []

    providers.search = empty
    await client.get("/api/home", params={"refill": True})
    task = service.catalog_task
    await client.get("/api/home", params={"refill": True})
    assert service.catalog_task is task
    await service.wait_for_idle()
    assert len(providers.searches) == 10
    assert {row[0] for row in providers.searches} == set(SOURCE_NAMES)
    await client.get("/api/home", params={"refill": True})
    assert len(providers.searches) == 10
    async with service.db.sessions() as db:
        cache = await db.get(ProviderCache, "catalog:all")
        cursor = cache.value["next_cursor"]
        cache.updated_at = now() - timedelta(seconds=61)
        await db.commit()
    await client.get("/api/home", params={"refill": True})
    await service.wait_for_idle()
    assert len(providers.searches) == 20 and providers.searches[-1][2] > providers.searches[0][2]
    assert (await service.cache("catalog:all")).value["next_cursor"] > cursor
    assert not (await client.get("/api/home")).json()["collection_failed"]


async def test_home_distinguishes_network_failure_from_healthy_empty_results(system):
    client, service, providers, _ = system
    providers.search_error = True
    await client.get("/api/home", params={"refill": True})
    await service.wait_for_idle()
    response = (await client.get("/api/home", params={"refill": True})).json()
    assert response["items"] == [] and response["collection_failed"]
    assert 0 < response["retry_after"] <= service.settings.failure_cooldown + 1
    async with service.db.sessions() as db:
        assert not list(await db.scalars(select(Song)))


async def test_empty_home_refreshes_after_cooldown_even_with_an_old_six_hour_cache(system):
    client, service, providers, _ = system

    async def empty(*args):
        providers.searches.append(args)
        return []

    providers.search = empty
    await service.set_cache("catalog:all", {"next_cursor": 0}, 21600)
    async with service.db.sessions() as db:
        cache = await db.get(ProviderCache, "catalog:all")
        cache.updated_at = now() - timedelta(seconds=61)
        await db.commit()
    response = await client.get("/api/home")
    assert response.status_code == 200
    await service.wait_for_idle()
    assert len(providers.searches) == 10


async def test_refill_does_not_grow_unbounded_pending_metadata(system):
    client, service, providers, _ = system
    service.enqueue = AsyncMock()
    service.settings.catalog_target = 500
    service.settings.verification_queue_size = 20
    await client.get("/api/home", params={"refill": True})
    await service.wait_for_idle()
    assert len(providers.searches) == 1
    async with service.db.sessions() as db:
        songs = list(await db.scalars(select(Song).where(Song.recommended.is_(True))))
        assert len(songs) == 20 and all(song.verification_state == "pending" for song in songs)


async def test_restart_recovers_incomplete_aggregate_metadata_without_waiting_for_ttl(system):
    import hashlib

    client, service, providers, _ = system
    key = "search:" + hashlib.sha256("all:重启:1".encode()).hexdigest()
    await service.set_cache(
        key,
        {
            "ids": [],
            "by_source": {},
            "search_sources": [
                {"source": source, "name": name, "status": "pending"}
                for source, name in SOURCE_NAMES.items()
            ],
        },
        600,
    )
    await client.get("/api/search", params={"q": "重启"})
    await service.wait_for_idle()
    assert len(providers.searches) == 5
    result = (await client.get("/api/search", params={"q": "重启"})).json()
    assert len(result["items"]) == 20 and all(
        row["status"] == "ok" for row in result["search_sources"]
    )


async def test_server_refills_empty_catalog_without_another_frontend_request_and_stops_on_network_failure(
    system,
):
    _, service, providers, _ = system

    async def empty(*args):
        providers.searches.append(args)
        return []

    providers.search = empty
    await service.set_cache("catalog:all", {"next_cursor": 0}, 21600)

    async def past_cooldown():
        async with service.db.sessions() as db:
            cache = await db.get(ProviderCache, "catalog:all")
            cache.updated_at = now() - timedelta(seconds=61)
            await db.commit()

    await past_cooldown()
    await service.maintain_catalog()
    await service.wait_for_idle()
    assert len(providers.searches) == 10
    await past_cooldown()
    await service.maintain_catalog()
    await service.wait_for_idle()
    assert len(providers.searches) == 20
    await service.set_cache("catalog:all", {"next_cursor": 20, "network_failed": True}, 60)
    await past_cooldown()
    await service.maintain_catalog()
    assert len(providers.searches) == 20


async def test_partial_aggregate_progress_is_visible_while_one_source_is_still_running(system):
    client, service, providers, _ = system
    gate, other_done = asyncio.Event(), asyncio.Event()
    original = providers.search

    async def search(source, *args):
        if source == "soda":
            await gate.wait()
        result = await original(source, *args)
        if source == "kuwo":
            other_done.set()
        return result

    providers.search = search
    await client.get("/api/search", params={"q": "慢来源"})
    try:
        await asyncio.wait_for(other_done.wait(), 5)
        result = (await client.get("/api/search", params={"q": "慢来源"})).json()
        assert result["refreshing"]
        assert any(row["status"] == "ok" for row in result["search_sources"])
        assert (
            next(row for row in result["search_sources"] if row["source"] == "soda")["status"]
            == "pending"
        )
    finally:
        gate.set()
        await service.wait_for_idle()
