import asyncio
import os
import ssl

from alembic import context
from sqlalchemy import pool
from sqlalchemy.ext.asyncio import async_engine_from_config

from music.db.models import Base

config = context.config
if os.environ.get("MUSIC_MIGRATION_DATABASE_URL"):
    config.set_main_option("sqlalchemy.url", os.environ["MUSIC_MIGRATION_DATABASE_URL"].replace("%", "%%"))


def run_migrations(connection):
    context.configure(connection=connection, target_metadata=Base.metadata, render_as_batch=False)
    with context.begin_transaction():
        context.run_migrations()


async def online():
    connect_args = {}
    if os.environ.get("MUSIC_DATABASE_TLS", "false").lower() == "true":
        connect_args["ssl"] = ssl.create_default_context(cafile=os.environ.get("MUSIC_DATABASE_CA_FILE"))
    engine = async_engine_from_config(
        config.get_section(config.config_ini_section), prefix="sqlalchemy.", poolclass=pool.NullPool, connect_args=connect_args
    )
    async with engine.connect() as connection:
        await connection.run_sync(run_migrations)
    await engine.dispose()


if context.is_offline_mode():
    context.configure(
        url=config.get_main_option("sqlalchemy.url"),
        target_metadata=Base.metadata,
        literal_binds=True,
    )
    with context.begin_transaction():
        context.run_migrations()
else:
    asyncio.run(online())
