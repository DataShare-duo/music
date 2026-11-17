"""Mark storage timezones without rewriting any existing timestamp cell."""

import sqlalchemy as sa
from alembic import context, op

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None

# Keep independent of future runtime metadata or bit-map changes.
TABLES = (
    "songs",
    "song_stats",
    "audio_links",
    "playback_sessions",
    "provider_cache",
    "users",
    "user_marks",
    "user_history",
    "user_operations",
)
NEW_MASK = 8191


def upgrade():
    for table in TABLES:
        # Existing rows are marked UTC (0), but not a single old time is changed.
        exists = (
            False
            if context.is_offline_mode()
            else any(
                col["name"] == "time_storage_mask"
                for col in sa.inspect(op.get_bind()).get_columns(table)
            )
        )
        if not exists:
            op.add_column(
                table,
                sa.Column("time_storage_mask", sa.Integer(), nullable=False, server_default="0"),
            )
        if op.get_bind().dialect.name == "sqlite":
            with op.batch_alter_table(table) as batch:
                batch.alter_column("time_storage_mask", server_default=str(NEW_MASK))
        else:
            op.alter_column(
                table, "time_storage_mask", existing_type=sa.Integer(), server_default=str(NEW_MASK)
            )


def downgrade():
    if context.is_offline_mode():
        raise RuntimeError("降级前必须在线检查时间标记，不能生成无条件回退 SQL")
    bind = op.get_bind()
    for name in TABLES:
        table = sa.table(name, sa.column("time_storage_mask", sa.Integer()))
        if bind.execute(
            sa.select(sa.func.count()).select_from(table).where(table.c.time_storage_mask != 0)
        ).scalar_one():
            raise RuntimeError("已存在北京时间写入，禁止丢弃时区标记，请恢复经过验证的备份")
    for table in reversed(TABLES):
        op.drop_column(table, "time_storage_mask")
