import json
import re

from music.core.config import ROOT


def test_native_project_declares_single_background_audio_and_no_webview_or_public_backend():
    root = ROOT / "miniprogram"
    project = json.loads((root / "project.config.json").read_text(encoding="utf-8"))
    app = json.loads((root / "src/app.json").read_text(encoding="utf-8"))
    assert project["appid"] == "wxe1af0ed55ed257b7"
    assert project["miniprogramRoot"] == "dist/"
    assert app["requiredBackgroundModes"] == ["audio"]
    for page in app["pages"]:
        assert (root / "src" / f"{page}.ts").is_file()
        assert (root / "src" / f"{page}.wxml").is_file()
    source = "\n".join(
        path.read_text(encoding="utf-8") for path in (root / "src").rglob("*") if path.is_file()
    )
    assert "<web-view" not in source
    assert ".run.tcloudbase.com" not in source
    assert not re.search(r"https?://", (root / "src/config.ts").read_text(encoding="utf-8"))
    assert source.count("wx.getBackgroundAudioManager()") == 1
    assert "wx.createInnerAudioContext" not in source
    assert "callContainer" in source
    assert "AppSecret" not in source.replace("AppSecret, upload keys", "")


def test_native_generated_and_private_files_do_not_enter_web_container():
    ignore = (ROOT / ".gitignore").read_text(encoding="utf-8")
    dockerignore = (ROOT / ".dockerignore").read_text(encoding="utf-8")
    assert "miniprogram/dist/" in ignore and "miniprogram/node_modules/" in ignore
    assert "miniprogram" in dockerignore.splitlines()
    assert "*.key" in ignore and "**/*.key" in dockerignore
    assert "*.pem" in ignore and "**/*.pem" in dockerignore
    package = json.loads((ROOT / "miniprogram/package.json").read_text(encoding="utf-8"))
    assert package["author"] == "DataShare"
    assert set(("build", "test", "upload")) <= package["scripts"].keys()
    assert (ROOT / "miniprogram/package-lock.json").is_file()


def test_native_entry_and_experience_qr_compatibility_are_consistent():
    root = ROOT / "miniprogram"
    app = json.loads((root / "src/app.json").read_text(encoding="utf-8"))
    project = json.loads((root / "project.config.json").read_text(encoding="utf-8"))
    assert app["entryPagePath"] == app["pages"][0] == "pages/home/index"
    assert project["condition"]["miniprogram"]["list"][0]["pathName"] == app["entryPagePath"]
    assert "page/index/index" in app["pages"]
    assert "pages/verify/index" in app["pages"]
    assert "onPageNotFound" in (root / "src/app.ts").read_text(encoding="utf-8")
    for page in ("page/index/index", "pages/verify/index"):
        assert "openHome()" in (root / "src" / f"{page}.ts").read_text(encoding="utf-8")
    assert "第一阶段" not in (root / "src/pages/home/index.wxml").read_text(encoding="utf-8")
    assert "&amp;" not in (root / "src/pages/home/index.wxml").read_text(encoding="utf-8")
    for page in ("home", "search"):
        config = json.loads((root / f"src/pages/{page}/index.json").read_text(encoding="utf-8"))
        assert config["usingComponents"]["player-bar"] == "/components/player-bar/index"
        assert "<player-bar" in (root / f"src/pages/{page}/index.wxml").read_text(encoding="utf-8")


def test_fullscreen_lyric_page_reuses_background_player_and_uses_native_text():
    root = ROOT / "miniprogram"
    app = json.loads((root / "src/app.json").read_text(encoding="utf-8"))
    assert "pages/player/index" in app["pages"] and app["entryPagePath"] == "pages/home/index"
    config = json.loads((root / "src/pages/player/index.json").read_text(encoding="utf-8"))
    assert config["navigationStyle"] == "custom" and config["disableScroll"]
    assert config["navigationBarTextStyle"] == "white"
    source = (root / "src/pages/player/index.ts").read_text(encoding="utf-8")
    assert "getBackgroundAudioManager" not in source and "createInnerAudioContext" not in source
    markup = (root / "src/pages/player/index.wxml").read_text(encoding="utf-8")
    assert "<rich-text" not in markup and "<web-view" not in markup
    assert "{{item.text}}" in markup and "lyricStatus === 'plain'" in markup
    style = (root / "src/pages/player/index.wxss").read_text(encoding="utf-8")
    assert "blur(" in style and "safe-area-inset-bottom" in style
    assert "resume(" in source and "pause()" in source
