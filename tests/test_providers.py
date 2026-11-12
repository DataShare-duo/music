from music.providers.official import cover


def test_soda_cover_adds_required_image_transform_once():
    base = "https://p3-luna.douyinpic.com/img/"
    expected = base + "tos-cn/test~c5_500x500.jpg"
    assert cover({"urls": [base], "uri": "tos-cn/test"}) == expected
    assert cover(expected) == expected
    assert cover("https://example.com/cover.jpg") == "https://example.com/cover.jpg"
    assert cover("javascript:alert(1)") == ""
