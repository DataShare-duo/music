"""Personal data tables for the MySQL-only mini program."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.mysql import MEDIUMBLOB

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def avatar_type():
    return MEDIUMBLOB() if op.get_bind().dialect.name == "mysql" else sa.LargeBinary()


def upgrade():
    op.create_table(
        "users",
        sa.Column("user_key", sa.String(64), primary_key=True),
        sa.Column("app_id", sa.String(64), nullable=False),
        sa.Column("avatar_blob", avatar_type(), nullable=True),
        sa.Column("avatar_mime", sa.String(40), nullable=True),
        sa.Column("avatar_sha256", sa.String(64), nullable=True),
        sa.Column("avatar_updated_at", sa.DateTime(), nullable=True),
        sa.Column("revision", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
    op.create_table(
        "user_marks",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "user_key",
            sa.String(64),
            sa.ForeignKey("users.user_key", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("kind", sa.String(20), nullable=False),
        sa.Column("source", sa.String(20), nullable=False),
        sa.Column("source_track_id", sa.String(100), nullable=False),
        sa.Column("title", sa.String(500), nullable=False),
        sa.Column("artist", sa.String(500), nullable=False),
        sa.Column("album", sa.String(500), nullable=False),
        sa.Column("cover_url", sa.Text(), nullable=False),
        sa.Column("duration", sa.Float(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("user_key", "kind", "source", "source_track_id"),
    )
    op.create_index("ix_user_marks_user_key", "user_marks", ["user_key"])
    op.create_index("ix_user_marks_kind", "user_marks", ["kind"])
    op.create_table(
        "user_history_state",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "user_key",
            sa.String(64),
            sa.ForeignKey("users.user_key", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("kind", sa.String(20), nullable=False),
        sa.Column("epoch", sa.Integer(), nullable=False, server_default="0"),
        sa.UniqueConstraint("user_key", "kind"),
    )
    op.create_index("ix_user_history_state_user_key", "user_history_state", ["user_key"])
    op.create_table(
        "user_history",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "user_key",
            sa.String(64),
            sa.ForeignKey("users.user_key", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("kind", sa.String(20), nullable=False),
        sa.Column("history_key", sa.String(220), nullable=False),
        sa.Column("query", sa.String(100), nullable=True),
        sa.Column("source", sa.String(20), nullable=True),
        sa.Column("source_track_id", sa.String(100), nullable=True),
        sa.Column("title", sa.String(500), nullable=True),
        sa.Column("artist", sa.String(500), nullable=True),
        sa.Column("album", sa.String(500), nullable=True),
        sa.Column("cover_url", sa.Text(), nullable=True),
        sa.Column("duration", sa.Float(), nullable=True),
        sa.Column("source_name", sa.String(80), nullable=True),
        sa.Column("happened_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("user_key", "kind", "history_key"),
    )
    op.create_index("ix_user_history_user_key", "user_history", ["user_key"])
    op.create_index("ix_user_history_kind", "user_history", ["kind"])
    op.create_index("ix_user_history_happened_at", "user_history", ["happened_at"])
    op.create_table(
        "user_operations",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "user_key",
            sa.String(64),
            sa.ForeignKey("users.user_key", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("operation_id", sa.String(100), nullable=False),
        sa.Column("kind", sa.String(20), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("user_key", "operation_id"),
    )
    op.create_index("ix_user_operations_user_key", "user_operations", ["user_key"])


def downgrade():
    for table in ("user_operations", "user_history", "user_history_state", "user_marks", "users"):
        op.drop_table(table)
