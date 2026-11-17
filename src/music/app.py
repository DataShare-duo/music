import asyncio
import logging
from contextlib import asynccontextmanager

from alembic import command
from alembic.config import Config
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException

from music import __author__
from music.api.native import router as native_router
from music.api.routes import router
from music.core.access import AccessMiddleware
from music.core.audio_probe import AudioProbe
from music.core.config import ROOT, Settings
from music.core.errors import AppError, error_handler
from music.core.lyrics import LyricsService
from music.core.streaming import AudioProxy
from music.db.session import Database
from music.personal import PersonalService
from music.providers.official import ProviderManager
from music.service import MusicService


def migrate(url):
    config = Config(str(ROOT / "alembic.ini"))
    config.set_main_option("script_location", str(ROOT / "migrations"))
    config.set_main_option("sqlalchemy.url", url.replace("%", "%%"))
    command.upgrade(config, "head")


def create_app(settings=None, providers=None, proxy=None, migrate_on_start=None, probe=None):
    logging.getLogger("httpx").setLevel(logging.WARNING)
    settings = settings or Settings()
    if migrate_on_start is None:
        migrate_on_start = settings.auto_migrate
    db = Database(
        settings.database_url, tls=settings.database_tls, ca_file=settings.database_ca_file
    )
    audio_proxy = proxy or AudioProxy(settings.network_timeout)
    service = MusicService(
        db,
        providers
        or ProviderManager(
            settings.provider_concurrency, settings.network_timeout, settings.provider_queue_size
        ),
        settings,
        probe or AudioProbe(audio_proxy, settings.full_audio_verify_concurrency),
    )

    @asynccontextmanager
    async def lifespan(app):
        if migrate_on_start:
            await asyncio.to_thread(migrate, settings.database_url)
        try:
            await db.check_time_schema()
            await service.start()
            yield
        finally:
            await service.close()
            await db.engine.dispose()

    app = FastAPI(
        title="听见 · 个人音乐空间",
        version="0.5.0",
        contact={"name": __author__, "url": "https://github.com/DataShare-duo/music"},
        lifespan=lifespan,
    )
    app.state.db, app.state.service = db, service
    app.state.settings = settings
    app.state.personal = PersonalService(db)
    app.state.proxy = audio_proxy
    app.state.lyrics = LyricsService(service)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_methods=["GET", "POST"],
        allow_headers=["Content-Type", "Range"],
        expose_headers=["Content-Range", "Accept-Ranges", "X-Audio-Version"],
    )
    app.add_middleware(AccessMiddleware, settings=settings)
    app.add_exception_handler(AppError, error_handler)

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, exc):
        return JSONResponse(
            status_code=422,
            content={
                "error": {
                    "code": "validation_error",
                    "message": "请求参数无效，请检查输入",
                    "playback_id": request.path_params.get("playback_id"),
                }
            },
        )

    @app.exception_handler(HTTPException)
    async def http_error(request: Request, exc):
        return JSONResponse(
            status_code=exc.status_code,
            content={
                "error": {
                    "code": "http_error",
                    "message": str(exc.detail),
                    "playback_id": request.path_params.get("playback_id"),
                }
            },
        )

    @app.exception_handler(Exception)
    async def internal_error(request: Request, exc):
        logging.getLogger(__name__).exception("Unhandled request error", exc_info=exc)
        return JSONResponse(
            status_code=500,
            content={
                "error": {
                    "code": "internal_error",
                    "message": "服务内部错误，请稍后重试",
                    "playback_id": request.path_params.get("playback_id"),
                }
            },
        )

    app.include_router(router)
    app.include_router(native_router)

    return app


app = create_app()
