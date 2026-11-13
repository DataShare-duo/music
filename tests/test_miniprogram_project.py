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
