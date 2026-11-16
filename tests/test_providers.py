from music.providers.official import cover


def test_soda_cover_adds_required_image_transform_once():
    base = "https://p3-luna.douyinpic.com/img/"
    expected = base + "tos-cn/test~c5_500x500.jpg"
    assert cover({"urls": [base], "uri": "tos-cn/test"}) == expected
    assert cover(expected) == expected
    assert cover("https://example.com/cover.jpg") == "https://example.com/cover.jpg"
    assert cover("javascript:alert(1)") == ""


def test_soda_empty_json_response_is_reported_with_upstream_request_id(monkeypatch):
    from music.core.errors import AppError
    from music.providers.official import OfficialProvider

    class Client:
        @staticmethod
        def _constructsearchurls(ctx, keyword):
            return ["https://api.qishui.com/luna/search/track?q=test"]

    class Response:
        content = b""
        headers = {"x-tt-logid": "log-123/unsafe"}

        def raise_for_status(self):
            return None

    class Session:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return None

        def get(self, *args, **kwargs):
            return Response()

    provider = OfficialProvider("soda", 3)
    monkeypatch.setattr(provider, "_client_class", lambda: Client)
    monkeypatch.setattr(provider, "_session", lambda: Session())
    try:
        provider.search_metadata("test", 1, 20)
    except AppError as exc:
        assert exc.code == "upstream_empty_response"
        assert "log-123unsafe" in exc.message
    else:
        raise AssertionError("empty upstream response should fail")
