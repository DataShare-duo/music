import base64

import pytest
from sqlalchemy import func, select
from test_api import system as system

from music.db.models import User

HEADERS = {
    "X-WX-APPID": "wxe1af0ed55ed257b7",
    "X-WX-OPENID": "openid-a",
    "X-WX-SOURCE": "wx_client",
}


def song(track="1"):
    return {
        "source": "soda",
        "source_track_id": track,
        "title": "测试歌曲 " + track,
        "artist": "测试歌手",
        "album": "测试专辑",
        "cover_url": "",
        "duration": 180,
    }


async def call(client, action, data=None, headers=HEADERS):
    return await client.post(
        "/api/miniprogram/personal",
        headers=headers,
        json={"action": action, "data": data or {}},
    )


async def test_personal_mysql_shape_api_is_isolated_and_idempotent(system):
    client, _, _, _ = system
    assert (await call(client, "profile.get")).json()["data"]["active"] is False
    assert (await call(client, "profile.enable")).status_code == 200
    mark = {"kind": "favorite", "value": True, "song": song(), "opId": "mark-1"}
    await call(client, "mark.set", mark)
    await call(client, "mark.set", mark)
    view = (await call(client, "profile.get")).json()["data"]
    assert len(view["favorite"]) == 1
    assert view["like"] == []
    history = {
        "kind": "recent",
        "epoch": view["recent"]["epoch"],
        "ops": [
            {"id": "recent-1", "type": "put", "at": 1000, "song": song(), "sourceName": "汽水音乐"}
        ],
    }
    assert (await call(client, "history.sync", history)).status_code == 200
    other = {**HEADERS, "X-WX-OPENID": "openid-b"}
    assert (await call(client, "profile.get", headers=other)).json()["data"]["active"] is False
    spoof = await call(client, "profile.enable", {"openid": "openid-b"})
    assert spoof.status_code == 400


async def test_personal_avatar_is_mysql_blob_and_private(system):
    client, _, _, _ = system
    await call(client, "profile.enable")
    content = b"\xff\xd8\xfftest-jpeg"
    result = await call(
        client,
        "avatar.set",
        {"base64": base64.b64encode(content).decode(), "mime": "image/jpeg"},
    )
    assert result.status_code == 200, result.text
    avatar = (await call(client, "avatar.get")).json()["data"]["avatar"]
    assert avatar.startswith("data:image/jpeg;base64,")
    invalid = await call(client, "avatar.set", {"base64": "bm90LWltYWdl", "mime": "image/png"})
    assert invalid.status_code == 400


async def test_personal_headers_are_required(system):
    client, _, _, _ = system
    response = await client.post(
        "/api/miniprogram/personal", json={"action": "profile.get", "data": {}}
    )
    assert response.status_code == 401
    wrong = await call(client, "profile.get", headers={**HEADERS, "X-WX-APPID": "wrong"})
    assert wrong.status_code == 401


@pytest.mark.parametrize("source", ["wx_client", "wx_client,opaque-context", "gateway-context"])
async def test_personal_accepts_gateway_source_without_assuming_fixed_enum(system, source):
    client, _, _, _ = system
    headers = {**HEADERS, "X-WX-SOURCE": source}
    response = await call(client, "profile.enable", headers=headers)
    assert response.status_code == 200, response.text
    assert response.json()["data"]["active"] is True


@pytest.mark.parametrize(
    ("change", "code"),
    [
        ({"X-WX-SOURCE": ""}, "wechat_source_missing"),
        ({"X-WX-SOURCE": " "}, "wechat_source_missing"),
        ({"X-WX-SOURCE": "x" * 257}, "wechat_source_missing"),
        ({"X-WX-SOURCE": "bad\x7fvalue"}, "wechat_source_missing"),
        ({"X-WX-APPID": ""}, "wechat_appid_missing"),
        ({"X-WX-APPID": "wx-untrusted"}, "wechat_appid_mismatch"),
        ({"X-WX-OPENID": ""}, "wechat_openid_missing"),
        ({"X-WX-OPENID": "bad,value"}, "wechat_openid_missing"),
        ({"X-WX-OPENID": "x" * 129}, "wechat_openid_missing"),
    ],
)
async def test_personal_identity_rejections_are_specific_and_do_not_create_users(system, change, code):
    client, service, _, _ = system
    response = await call(client, "profile.enable", headers={**HEADERS, **change})
    assert response.status_code == 401
    assert response.json()["error"]["code"] == code
    async with service.db.sessions() as db:
        assert await db.scalar(select(func.count()).select_from(User)) == 0


async def test_identity_probe_is_private_non_mutating_and_does_not_leak_headers(system, caplog):
    client, service, _, _ = system
    good = await client.get("/api/miniprogram/identity", headers=HEADERS)
    assert good.status_code == 200
    assert good.json() == {"status": "ok"}
    denied = await client.get(
        "/api/miniprogram/identity", headers={**HEADERS, "X-WX-APPID": "private-sentinel"}
    )
    assert denied.status_code == 401
    missing = await client.get("/api/miniprogram/identity")
    assert missing.status_code == 401
    assert "reason=wechat_appid_mismatch" in caplog.text
    for secret in ["private-sentinel", "openid-a"]:
        assert secret not in caplog.text
        assert secret not in denied.text
    async with service.db.sessions() as db:
        assert await db.scalar(select(func.count()).select_from(User)) == 0


async def test_client_json_and_shared_environment_headers_cannot_replace_direct_identity(system):
    client, _, _, _ = system
    headers = {
        "X-WX-SOURCE": "gateway-context",
        "X-WX-FROM-APPID": HEADERS["X-WX-APPID"],
        "X-WX-FROM-OPENID": "openid-a",
    }
    denied = await call(client, "profile.enable", {"openid": "openid-a"}, headers)
    assert denied.status_code == 401
    for key in ["openid", "userId", "userKey"]:
        spoof = await call(client, "profile.enable", {key: "openid-b"})
        assert spoof.status_code == 400
        assert spoof.json()["error"]["code"] == "invalid_identity"
