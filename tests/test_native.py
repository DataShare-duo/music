import asyncio
from datetime import timedelta
from uuid import uuid4

import pytest
from test_api import playback, song_id
from test_api import system as system

from music.core.direct_audio import DirectAudioCheck
from music.core.errors import AppError
from music.core.verification import VerifiedAudio
from music.db.models import Playback, Song, SongStats, now
from music.providers.official import ResolvedAudio, Track


async def native(client, id_, request_id=None):
    return await client.post(
        f"/api/miniprogram/songs/{id_}/playbacks",
        json={"client_request_id": request_id or str(uuid4())},
    )


async def test_native_ready_can_start_without_proxy_but_web_cannot(system):
    client, service, _, proxy = system
    id_ = await song_id(client, service)
    response = await native(client, id_)
    assert response.status_code == 200, response.text
    pb = response.json()
    assert pb["transport"] == "direct" and pb["audio_url"].startswith("https://")
    assert "stream_url" not in pb and "headers" not in response.text and not proxy.calls
    async with service.db.sessions() as db:
        session = await db.get(Playback, pb["id"])
        assert session.audio_headers == {} and session.transport == "direct"
    results = await asyncio.gather(
        *[client.post(f"/api/miniprogram/playbacks/{pb['id']}/started") for _ in range(3)]
    )
    assert all(r.status_code == 200 for r in results)
    web = (await playback(client, id_)).json()
    assert (await client.post(f"/api/playbacks/{web['id']}/started")).status_code == 409
    async with service.db.sessions() as db:
        stats = await db.get(SongStats, id_)
        assert stats.click_count == 2 and stats.listen_count == 1


async def test_native_and_proxy_routes_cannot_mix_sessions_or_request_ids(system):
    client, service, _, _ = system
    id_ = await song_id(client, service)
    request_id = str(uuid4())
    pb = (await native(client, id_, request_id)).json()
    repeated = await native(client, id_, request_id)
    assert repeated.json()["id"] == pb["id"]
    assert (await playback(client, id_, request_id)).status_code == 409
    for method, suffix, body in (
        ("get", "", None),
        ("get", "/stream", None),
        ("post", "/started", {}),
        ("post", "/refresh", {"expected_version": pb["link_version"]}),
    ):
        path = f"/api/playbacks/{pb['id']}{suffix}"
        result = await client.get(path) if method == "get" else await client.post(path, json=body)
        assert result.status_code == 409
    web = (await playback(client, id_)).json()
    assert "audio_url" not in web
    for suffix, body in (
        ("", None),
        ("/started", {}),
        ("/refresh", {"expected_version": web["link_version"]}),
    ):
        path = f"/api/miniprogram/playbacks/{web['id']}{suffix}"
        result = await client.get(path) if body is None else await client.post(path, json=body)
        assert result.status_code == 409


async def test_direct_incompatibility_does_not_hide_web_song(system):
    client, service, _, _ = system
    id_ = await song_id(client, service)

    class Unsupported:
        async def check(self, verified):
            raise DirectAudioCheck.unsupported()

    service.direct_check = Unsupported()
    response = await native(client, id_)
    assert response.status_code == 409
    error = response.json()["error"]
    assert (
        error["code"] == "direct_audio_unsupported" and error["playback_id"] and not error["hidden"]
    )
    async with service.db.sessions() as db:
        assert (await db.get(Song, id_)).verification_state == "available"
        assert (await db.get(SongStats, id_)).listen_count == 0
        assert (await db.get(Playback, error["playback_id"])).state == "failed"
    assert (await playback(client, id_)).status_code == 200


async def test_native_refresh_quota_stale_versions_and_unsupported_do_not_hide(system):
    client, service, providers, _ = system
    id_ = await song_id(client, service)
    pb = (await native(client, id_)).json()
    first = (
        await client.post(
            f"/api/miniprogram/playbacks/{pb['id']}/refresh",
            json={"expected_version": pb["link_version"]},
        )
    ).json()
    assert first["refresh_count"] == 1 and first["link_version"] > pb["link_version"]
    stale = await client.post(
        f"/api/miniprogram/playbacks/{pb['id']}/refresh",
        json={"expected_version": pb["link_version"]},
    )
    assert stale.status_code == 200
    exhausted = await client.post(
        f"/api/miniprogram/playbacks/{pb['id']}/refresh",
        json={"expected_version": first["link_version"]},
    )
    assert exhausted.status_code == 409 and exhausted.json()["error"]["code"] == "refresh_exhausted"
    assert not exhausted.json()["error"]["hidden"]
    assert (await client.get(f"/api/miniprogram/playbacks/{pb['id']}")).json()["state"] == "ready"
    async with service.db.sessions() as db:
        assert (await db.get(Song, id_)).verification_state == "available"


async def test_native_actual_source_failure_keeps_existing_hide_and_recheck(system):
    client, service, providers, _ = system
    id_ = await song_id(client, service)
    pb = (await native(client, id_)).json()
    providers.resolve_error = True
    response = await client.post(
        f"/api/miniprogram/playbacks/{pb['id']}/refresh",
        json={"expected_version": pb["link_version"]},
    )
    assert response.json()["error"]["code"] == "full_audio_unavailable"
    async with service.db.sessions() as db:
        assert (await db.get(Song, id_)).next_check_at > now()


async def test_native_action_rate_and_busy_refresh_keep_protection(system):
    client, service, _, _ = system
    id_ = await song_id(client, service)
    pb = (await native(client, id_)).json()

    class Busy:
        async def check(self, verified):
            raise AppError("service_busy", "busy", 503)

    service.direct_check = Busy()
    response = await client.post(
        f"/api/miniprogram/playbacks/{pb['id']}/refresh",
        json={"expected_version": pb["link_version"]},
    )
    assert response.status_code == 503
    current = (await client.get(f"/api/miniprogram/playbacks/{pb['id']}")).json()
    assert current["refresh_count"] == 0 and current["state"] == "ready"
    service.settings.action_rate_per_minute = 1
    assert (await native(client, id_)).status_code == 429


async def test_native_session_expiry_is_enforced(system):
    client, service, _, _ = system
    pb = (await native(client, await song_id(client, service))).json()
    async with service.db.sessions() as db:
        (await db.get(Playback, pb["id"])).expires_at = now() - timedelta(seconds=1)
        await db.commit()
    assert (await client.get(f"/api/miniprogram/playbacks/{pb['id']}")).status_code == 410


@pytest.mark.parametrize("url", ["http://audio.example/full.mp3", "file:///full.mp3"])
async def test_direct_checker_rejects_non_https_before_probe(url):
    class Unused:
        async def duration(self, *args):
            pytest.fail("must not request network")

    with pytest.raises(AppError) as error:
        await DirectAudioCheck(Unused()).check(
            VerifiedAudio(
                Track("soda", "1", "song", duration=180), ResolvedAudio(url, {}, "full"), 180
            )
        )
    assert error.value.code == "direct_audio_unsupported"


async def test_direct_checker_strips_headers_requires_full_length_and_preserves_busy():
    class Probe:
        duration_value = 180
        busy = False

        async def duration(self, audio, timeout):
            assert not audio.headers and audio.https_only
            if self.busy:
                raise AppError("service_busy", "busy", 503)
            return self.duration_value

    probe = Probe()
    verified = VerifiedAudio(
        Track("soda", "1", "song", duration=180),
        ResolvedAudio("https://audio.example/full.mp3", {"Referer": "secret"}, "full"),
        180,
    )
    assert await DirectAudioCheck(probe).check(verified) == verified.audio.url
    assert verified.audio.headers == {"Referer": "secret"}
    probe.duration_value = 30
    with pytest.raises(AppError, match="当前完整版音源"):
        await DirectAudioCheck(probe).check(verified)
    probe.busy = True
    with pytest.raises(AppError) as error:
        await DirectAudioCheck(probe).check(verified)
    assert error.value.code == "service_busy"


@pytest.mark.parametrize(
    ("source", "url", "expected"),
    [
        (
            "netease",
            "http://m801.music.126.net/a.mp3?token=keep",
            "https://m801.music.126.net/a.mp3?token=keep",
        ),
        ("netease", "http://m701.music.126.net:80/a", "https://m701.music.126.net/a"),
        ("kuwo", "http://kw-lv.kuwo.cn/a.mp3?bitrate", "https://kw-lv.kuwo.cn/a.mp3?bitrate"),
        ("kuwo", "http://kw-er.sycdn.kuwo.cn/a", "https://kw-er.sycdn.kuwo.cn/a"),
    ],
)
async def test_official_http_candidate_is_returned_only_after_https_full_validation(
    source, url, expected
):
    class Probe:
        async def duration(self, audio, timeout):
            assert audio.url == expected and not audio.headers and audio.https_only
            return 180

    verified = VerifiedAudio(
        Track(source, "1", "song", duration=180),
        ResolvedAudio(url, {"Referer": "platform"}, "full"),
        180,
    )
    assert await DirectAudioCheck(Probe()).check(verified) == expected
    assert verified.audio.url == url and verified.audio.headers == {"Referer": "platform"}


@pytest.mark.parametrize(
    ("source", "url"),
    [
        ("soda", "http://m801.music.126.net/a"),
        ("netease", "http://music.126.net.evil.example/a"),
        ("netease", "http://notmusic.126.net/a"),
        ("kuwo", "http://kuwo.cn.evil.example/a"),
        ("kuwo", "http://127.0.0.1/a"),
        ("netease", "http://user:secret@m801.music.126.net/a"),
        ("netease", "http://m801.music.126.net:8080/a"),
        ("kuwo", "https://kw-lv.kuwo.cn:8080/a"),
        ("kuwo", "http://kw-lv.kuwo.cn:invalid/a"),
    ],
)
async def test_https_conversion_rejects_untrusted_source_authority_and_port(source, url):
    class Unused:
        async def duration(self, *args):
            pytest.fail("unsafe candidate must not reach network")

    with pytest.raises(AppError) as error:
        await DirectAudioCheck(Unused()).check(
            VerifiedAudio(
                Track(source, "1", "song", duration=180), ResolvedAudio(url, {}, "full"), 180
            )
        )
    assert error.value.code == "direct_audio_unsupported"


async def test_official_https_failure_does_not_fall_back_to_http_and_error_is_specific():
    seen = []

    class Blocked:
        async def duration(self, audio, timeout):
            seen.append(audio.url)
            raise AppError("probe_link_unavailable", "do not expose signed URL")

    original = "http://kw-lv.kuwo.cn/audio?secret=token"
    with pytest.raises(AppError) as error:
        await DirectAudioCheck(Blocked()).check(
            VerifiedAudio(
                Track("kuwo", "1", "song", duration=180), ResolvedAudio(original, {}, "full"), 180
            )
        )
    assert seen == ["https://kw-lv.kuwo.cn/audio?secret=token"]
    assert "拒绝访问或链接已失效" in error.value.message
    assert "secret" not in error.value.message and not error.value.hidden


async def test_native_https_candidate_saved_only_to_native_session_not_web_link(system):
    from music.db.models import AudioLink

    client, service, providers, _ = system
    ids = await service.upsert_tracks([Track("netease", "http-track", "song", duration=90)])
    await service.enqueue(ids)
    await service.wait_for_idle()
    original = "http://m801.music.126.net/audio?token=keep"

    async def resolve(*args):
        return ResolvedAudio(original, {"Referer": "https://music.163.com/"}, "unknown")

    providers.resolve = resolve
    response = await native(client, ids[0])
    assert response.status_code == 200, response.text
    assert response.json()["audio_url"] == original.replace("http:", "https:", 1)
    async with service.db.sessions() as db:
        session = await db.get(Playback, response.json()["id"])
        assert session.audio_url.startswith("https://") and session.audio_headers == {}
        assert (await db.get(AudioLink, ids[0])).url == original
        assert (await db.get(Song, ids[0])).verification_state == "available"
    web = (await playback(client, ids[0])).json()
    async with service.db.sessions() as db:
        assert (await db.get(Playback, web["id"])).audio_url == original
