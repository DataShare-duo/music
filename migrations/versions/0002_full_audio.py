"""Full-audio verification state and session-scoped source snapshots

Revision ID: 0002
"""

import sqlalchemy as sa
from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "songs",
        sa.Column("verification_state", sa.String(20), nullable=False, server_default="pending"),
    )
    op.add_column("songs", sa.Column("checked_at", sa.DateTime(), nullable=True))
    op.add_column("songs", sa.Column("next_check_at", sa.DateTime(), nullable=True))
    op.add_column("songs", sa.Column("verification_error", sa.Text(), nullable=True))
    op.add_column("songs", sa.Column("verified_track", sa.JSON(), nullable=True))
    op.add_column("songs", sa.Column("audio_duration", sa.Float(), nullable=True))
    op.create_index("ix_songs_verification_state", "songs", ["verification_state"])
    op.create_index("ix_songs_next_check_at", "songs", ["next_check_at"])
    for table in ("audio_links", "playback_sessions"):
        op.add_column(table, sa.Column("play_source", sa.String(20), nullable=True))
        op.add_column(table, sa.Column("play_track", sa.JSON(), nullable=True))
        op.add_column(table, sa.Column("audio_duration", sa.Float(), nullable=True))
    op.add_column("playback_sessions", sa.Column("audio_url", sa.Text(), nullable=True))
    op.add_column("playback_sessions", sa.Column("audio_headers", sa.JSON(), nullable=True))
    op.add_column("playback_sessions", sa.Column("audio_expires_at", sa.DateTime(), nullable=True))
    op.execute(
        "UPDATE playback_sessions SET state='failed', error_code='full_audio_required', error_message='请重新选择已验证完整版的歌曲'"
    )


def downgrade():
    for name in ("audio_url", "audio_headers", "audio_expires_at"):
        op.drop_column("playback_sessions", name)
    for table in ("audio_links", "playback_sessions"):
        for name in ("play_source", "play_track", "audio_duration"):
            op.drop_column(table, name)
    op.drop_index("ix_songs_next_check_at", table_name="songs")
    op.drop_index("ix_songs_verification_state", table_name="songs")
    for name in (
        "verification_state",
        "checked_at",
        "next_check_at",
        "verification_error",
        "verified_track",
        "audio_duration",
    ):
        op.drop_column("songs", name)
