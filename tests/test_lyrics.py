import asyncio
from contextlib import nullcontext
from datetime import timedelta
from types import SimpleNamespace
from uuid import uuid4

import pytest
from sqlalchemy import select
from test_api import playback, song_id
from test_api import system as system

from music.core.errors import AppError
from music.core.lyrics import MAX_LINES, MAX_TEXT_BYTES, LyricPayload, parse_lyrics
from music.db.models import Playback, ProviderCache, Song, SongStats, now
from music.providers.official import OfficialProvider


def test_lrc_normalizes_bom_metadata_offsets_multiple_stamps_and_equal_times():
    status, lines, plain = parse_lyrics(
        LyricPayload(
            text="\ufeff[ti:标题]\r\n[ar:歌手]\r\n[offset:500]\r\n[00:02.10][00:01.000]合成测试行\r\n[00:01.000]第二测试行\r\n[00:00.1]开头\r\n[00:01.000]第二测试行"
        )
    )
    assert status == "synced" and not plain
    assert [(line.time_ms, line.text) for line in lines] == [
        (0, "开头"),
        (500, "合成测试行\n第二测试行"),
        (1600, "合成测试行"),
    ]


def test_lrc_negative_offset_and_plain_text_not_faked_as_synchronized():
    status, lines, _ = parse_lyrics(LyricPayload(text="[offset:-200]\n[00:00.001]测试"))
    assert lines[0].time_ms == 201
    status, lines, plain = parse_lyrics(LyricPayload(text="[ti:元数据]\n静态测试文本\n下一行"))
    assert status == "plain" and lines == [] and plain == "静态测试文本\n下一行"
    assert parse_lyrics(LyricPayload(text="[00:88]无效时间\n[9999:00]超界"))[0] == "unavailable"


def test_kuwo_rows_and_explicit_instrumental_flags_are_distinguished():
    status, lines, _ = parse_lyrics(
        LyricPayload(
            rows=[
                {"time": "1.25", "lineLyric": "测试 &amp; 文本"},
                {"time": "0", "lineLyric": "开头"},
            ]
        )
    )
    assert status == "synced" and [(line.time_ms, line.text) for line in lines] == [
        (0, "开头"),
        (1250, "测试 & 文本"),
    ]
    assert parse_lyrics(LyricPayload(instrumental=True))[0] == "instrumental"
    assert parse_lyrics(LyricPayload(text="[00:00.000]纯音乐，请欣赏"))[0] == "instrumental"
    assert parse_lyrics(LyricPayload(text=""))[0] == "unavailable"
    assert parse_lyrics(LyricPayload(text="NULL"))[0] == "unavailable"
    assert parse_lyrics(LyricPayload(rows=[{"time": "nan", "lineLyric": "静态行"}]))[0] == "plain"


@pytest.mark.parametrize(
    "payload",
    [
        LyricPayload(text="x" * (MAX_TEXT_BYTES + 1)),
        LyricPayload(rows=[{}] * (MAX_LINES + 1)),
        LyricPayload(text="[00:01]" * (MAX_LINES + 1) + "测试"),
    ],
)
def test_oversized_lyrics_are_rejected_without_silent_truncation(payload):
    with pytest.raises(AppError) as error:
        parse_lyrics(payload)
    assert error.value.code == "lyrics_too_large"


@pytest.mark.parametrize("source", ["soda", "netease", "kuwo"])
def test_official_lyric_adapters_only_fetch_lyrics_from_fixed_endpoints(monkeypatch, source):
    provider = OfficialProvider(source, 8)
    monkeypatch.setattr(provider, "_session", lambda: nullcontext(object()))
    monkeypatch.setattr(provider, "resolve_audio", lambda *_: pytest.fail("must not resolve audio"))
    calls = []

    def request(session, method, url, **kwargs):
        calls.append((method, url, kwargs))
        if source == "netease":
            return SimpleNamespace(json=lambda: {"code": 200, "lrc": {"lyric": "[00:01]测试"}})
        if source == "kuwo":
            return SimpleNamespace(
                json=lambda: {"data": {"lrclist": [{"time": "1", "lineLyric": "测试"}]}}
            )
        return SimpleNamespace(json=lambda: {"lyric": "[00:01]测试"})

    monkeypatch.setattr(provider, "_lyric_request", request)

    class Soda:
        @staticmethod
        def _getsongmetainfo(ctx, id_):
            return ctx.get("https://music.douyin.com/qishui/share/track?track_id=" + id_).json()

    monkeypatch.setattr(provider, "_client_class", lambda: Soda)
    assert parse_lyrics(provider.fetch_lyrics("123"))[0] == "synced"
    assert len(calls) == 1 and calls[0][1].startswith("https://")
    assert calls[0][2].get("params", {}).get("musicId", "123") == "123"
    with pytest.raises(AppError):
        provider.fetch_lyrics("../arbitrary")


def test_lyric_transport_caps_body_refuses_unchecked_redirects_and_closes():
    class Response:
        encoding = None
        is_redirect = False
        closed = False
        chunks = [b"abc"]

        def __enter__(self):
            return self

        def __exit__(self, *args):
            self.closed = True

        def raise_for_status(self):
            pass

        def iter_content(self, size):
            yield from self.chunks

    response = Response()
    seen = []
    session = SimpleNamespace(request=lambda *args, **kwargs: seen.append(kwargs) or response)
    provider = OfficialProvider("soda", 8)
    result = provider._lyric_request(session, "GET", "https://music.douyin.com/qishui/share/track")
    assert result._content == b"abc" and response.closed
    assert seen[0]["allow_redirects"] is False and seen[0]["stream"]
    response.chunks = [b"x" * (2 * 1024 * 1024), b"x"]
    with pytest.raises(AppError):
        provider._lyric_request(session, "GET", "https://music.douyin.com/a")
    assert response.closed
    response.is_redirect = True
    with pytest.raises(AppError):
        provider._lyric_request(session, "GET", "https://music.douyin.com/a")
    with pytest.raises(AppError):
        provider._lyric_request(session, "GET", "https://127.0.0.1/a")


async def native(client, id_):
    response = await client.post(
        f"/api/miniprogram/songs/{id_}/playbacks", json={"client_request_id": str(uuid4())}
    )
    assert response.status_code == 200, response.text
    return response.json()


async def test_lyrics_use_actual_fallback_source_without_resolving_audio_or_changing_stats(system):
    client, service, providers, proxy = system
    service.probe.by_source = {"soda": 30}
    id_ = await song_id(client, service)
    pb = await native(client, id_)
    assert pb["play_source"] == "netease" and pb["play_source_track_id"] == "0"
    resolutions = len(providers.resolutions)
    searches = len(providers.searches)
    calls = []

    async def lyrics(source, id_):
        calls.append((source, id_))
        return LyricPayload(text="[00:01]测试歌词")

    providers.lyrics = lyrics
    result = await client.get(f"/api/miniprogram/playbacks/{pb['id']}/lyrics")
    assert result.status_code == 200
    view = result.json()
    assert (
        view["status"] == "synced"
        and view["source"] == "netease"
        and view["source_track_id"] == "0"
    )
    assert "audio_url" not in view and "headers" not in view
    assert (
        calls == [("netease", "0")]
        and len(providers.resolutions) == resolutions
        and len(providers.searches) == searches
        and not proxy.calls
    )
    async with service.db.sessions() as db:
        stats = await db.get(SongStats, id_)
        current = await db.get(Playback, pb["id"])
        assert stats.click_count == 1 and stats.listen_count == 0 and current.state == "ready"
        assert (await db.get(Song, id_)).verification_state == "available"


async def test_lyric_cache_and_concurrent_deduplication_are_source_and_track_scoped(system):
    client, service, providers, _ = system
    id_ = await song_id(client, service)
    pb = await native(client, id_)
    second = await native(client, id_)
    calls = []

    async def lyrics(source, id_):
        calls.append((source, id_))
        await asyncio.sleep(0.01)
        return LyricPayload(text="[00:01]测试")

    providers.lyrics = lyrics
    results = await asyncio.gather(
        *[client.get(f"/api/miniprogram/playbacks/{pb['id']}/lyrics") for _ in range(3)]
    )
    assert all(result.json()["status"] == "synced" for result in results) and len(calls) == 1
    await client.get(f"/api/miniprogram/playbacks/{second['id']}/lyrics")
    assert len(calls) == 1
    async with service.db.sessions() as db:
        current = await db.get(Playback, second["id"])
        current.play_source = "kuwo"
        current.play_track = {**current.play_track, "source": "kuwo"}
        await db.commit()
    await client.get(f"/api/miniprogram/playbacks/{second['id']}/lyrics")
    assert calls[-1] == ("kuwo", "0") and len(calls) == 2


async def test_lyric_errors_cool_down_and_do_not_hide_or_interrupt_song(system):
    client, service, providers, _ = system
    id_ = await song_id(client, service)
    pb = await native(client, id_)
    calls = []

    async def lyrics(*args):
        calls.append(args)
        raise AppError("upstream_timeout", "must not expose upstream details")

    providers.lyrics = lyrics
    path = f"/api/miniprogram/playbacks/{pb['id']}/lyrics"
    for _ in range(2):
        response = await client.get(path)
        view = response.json()
        assert view["status"] == "error" and view["retry_after"] > 0
        assert "upstream details" not in response.text
    assert len(calls) == 1
    async with service.db.sessions() as db:
        cache = await db.scalar(select(ProviderCache).where(ProviderCache.key.like("lyrics:%")))
        assert (
            cache.expires_at - cache.updated_at
        ).total_seconds() <= service.settings.failure_cooldown + 1
        cache.expires_at = now() - timedelta(seconds=1)
        await db.commit()
    await client.get(path)
    assert len(calls) == 2
    async with service.db.sessions() as db:
        assert (await db.get(Song, id_)).verification_state == "available"
        assert (await db.get(Playback, pb["id"])).state == "ready"


@pytest.mark.parametrize(
    ("payload", "status", "ttl"),
    [
        (LyricPayload(), "unavailable", 21600),
        (LyricPayload(instrumental=True), "instrumental", 21600),
        (LyricPayload(text="静态词"), "plain", 86400),
    ],
)
async def test_lyric_statuses_and_cache_expiries(system, payload, status, ttl):
    client, service, providers, _ = system
    pb = await native(client, await song_id(client, service))

    async def lyrics(*args):
        return payload

    providers.lyrics = lyrics
    response = await client.get(f"/api/miniprogram/playbacks/{pb['id']}/lyrics")
    assert response.json()["status"] == status
    async with service.db.sessions() as db:
        cache = await db.scalar(select(ProviderCache).where(ProviderCache.key.like("lyrics:%")))
        assert abs((cache.expires_at - cache.updated_at).total_seconds() - ttl) < 1


async def test_lyrics_reject_proxy_unknown_expired_or_unready_sessions(system):
    client, service, providers, _ = system
    id_ = await song_id(client, service)
    web = (await playback(client, id_)).json()
    pb = await native(client, id_)
    assert (await client.get(f"/api/miniprogram/playbacks/{web['id']}/lyrics")).status_code == 409
    assert (await client.get("/api/miniprogram/playbacks/unknown/lyrics")).status_code == 404
    async with service.db.sessions() as db:
        current = await db.get(Playback, pb["id"])
        current.play_track = None
        await db.commit()
    assert (await client.get(f"/api/miniprogram/playbacks/{pb['id']}/lyrics")).status_code == 409
    async with service.db.sessions() as db:
        current = await db.get(Playback, pb["id"])
        current.expires_at = now() - timedelta(seconds=1)
        await db.commit()
    assert (await client.get(f"/api/miniprogram/playbacks/{pb['id']}/lyrics")).status_code == 410


async def test_lyric_cache_failure_does_not_leak_content_or_modify_playback(system):
    client, service, providers, _ = system
    id_ = await song_id(client, service)
    pb = await native(client, id_)

    async def lyrics(*args):
        return LyricPayload(text="[00:01]不应写入错误响应的测试正文")

    async def failed_cache(*args):
        raise RuntimeError("不应写入错误响应的测试正文")

    providers.lyrics = lyrics
    service.set_cache = failed_cache
    response = await client.get(f"/api/miniprogram/playbacks/{pb['id']}/lyrics")
    assert response.status_code == 200 and response.json()["status"] == "error"
    assert "测试正文" not in response.text
    async with service.db.sessions() as db:
        assert (await db.get(Playback, pb["id"])).state == "ready"
        assert (await db.get(Song, id_)).verification_state == "available"
