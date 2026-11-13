"""Defer automatic shared-song clicks until real playback starts."""

import sqlalchemy as sa
from alembic import op

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "playback_sessions",
        sa.Column("click_pending", sa.Boolean(), nullable=False, server_default="0"),
    )


def downgrade():
    op.drop_column("playback_sessions", "click_pending")
