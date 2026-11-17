"""Identity injected by the trusted WeChat Cloud Run gateway, not client JSON.

The container must not have a public route bypassing that gateway. X-WX-SOURCE
is documented as a presence marker; its value is not a fixed wx_client enum.
"""

import logging
import re

from fastapi import Request

from music.core.errors import AppError

logger = logging.getLogger(__name__)


def require_wechat_identity(request: Request) -> tuple[str, str]:
    app_id = request.headers.get("x-wx-appid", "").strip()
    openid = request.headers.get("x-wx-openid", "").strip()
    source = request.headers.get("x-wx-source", "").strip()
    code = message = ""
    if not source or len(source) > 256 or any(ord(c) < 32 or ord(c) == 127 for c in source):
        code = "wechat_source_missing"
        message = "未收到微信云调用来源，请使用小程序云调用，并检查云托管入口配置"
    elif not app_id:
        code = "wechat_appid_missing"
        message = "未收到微信应用身份，请检查云托管是否属于当前小程序"
    elif app_id != request.app.state.settings.wechat_app_id:
        code = "wechat_appid_mismatch"
        message = "小程序身份与后端配置不匹配，请检查 MUSIC_WECHAT_APP_ID"
    elif not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", openid):
        code = "wechat_openid_missing"
        message = "未收到有效的微信用户身份，请检查云托管身份透传；资源复用时需核对环境归属"
    if code:
        # Never log raw header values, OpenID, cookies or request bodies.
        logger.warning(
            "WeChat identity rejected: reason=%s appid_present=%s openid_present=%s source_present=%s",
            code,
            bool(app_id),
            bool(openid),
            bool(source),
        )
        raise AppError(code, message, 401)
    return app_id, openid
