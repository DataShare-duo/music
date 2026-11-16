import ssl

from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine


class Database:
    def __init__(self, url: str, *, tls=False, ca_file=None):
        parsed = make_url(url)
        connect_args = (
            {"charset": "utf8mb4", "connect_timeout": 10}
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
