import ssl

from sqlalchemy import select
from sqlalchemy.engine import make_url
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine


class Database:
    def __init__(self, url: str, *, tls=False, ca_file=None):
        parsed = make_url(url)
        connect_args = (
            {
                "charset": "utf8mb4",
                "connect_timeout": 10,
                "init_command": "SET time_zone = '+08:00'",
            }
            if parsed.drivername.startswith("mysql")
            else {}
        )
        if tls and parsed.drivername.startswith("mysql"):
            connect_args["ssl"] = ssl.create_default_context(cafile=ca_file)
        self.engine = create_async_engine(
            url,
            pool_pre_ping=True,
            pool_size=5,
            max_overflow=3,
            pool_recycle=300,
            hide_parameters=True,
            connect_args=connect_args,
        )
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)

    async def check_time_schema(self):
        """Fail before background jobs if the non-destructive marker upgrade is missing."""
        from music.db.models import Base

        try:
            async with self.engine.connect() as connection:
                for table in Base.metadata.tables.values():
                    if "time_storage_mask" in table.c:
                        await connection.execute(select(table.c.time_storage_mask).limit(0))
        except DBAPIError as exc:
            code = exc.orig.args[0] if getattr(exc.orig, "args", ()) else None
            missing = (
                code in (1054, 1146)
                or "no such column" in str(code)
                or "no such table" in str(code)
            )
            if not missing:
                raise
            raise RuntimeError(
                "数据库尚未完成北京时间存储结构升级，请先停止旧版写入并使用迁移账号执行 "
                "alembic upgrade head（0006），迁移不会转换已有时间字段"
            ) from exc
