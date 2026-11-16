import base64

from test_api import system as system

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
