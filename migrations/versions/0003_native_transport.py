"""Separate native direct sessions from legacy proxy sessions.

Revision ID: 0003
"""

import sqlalchemy as sa
from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "playback_sessions",
        sa.Column("transport", sa.String(20), nullable=False, server_default="proxy"),
    )


def downgrade():
    op.drop_column("playback_sessions", "transport")
