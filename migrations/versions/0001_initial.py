"""Initial music catalog and playback schema

Revision ID: 0001
"""

import sqlalchemy as sa
from alembic import op

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "songs",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("source", sa.String(20), nullable=False),
        sa.Column("source_track_id", sa.String(100), nullable=False),
        sa.Column("title", sa.String(500), nullable=False),
        sa.Column("artist", sa.String(500), nullable=False),
        sa.Column("album", sa.String(500), nullable=False),
        sa.Column("cover_url", sa.Text(), nullable=False),
        sa.Column("duration", sa.Float(), nullable=False),
        sa.Column("recommended", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("source", "source_track_id"),
    )
    op.create_index("ix_songs_source", "songs", ["source"])
    op.create_index("ix_songs_recommended", "songs", ["recommended"])
    op.create_table(
        "song_stats",
        sa.Column(
            "song_id", sa.Integer(), sa.ForeignKey("songs.id", ondelete="CASCADE"), primary_key=True
        ),
        sa.Column("click_count", sa.Integer(), nullable=False),
        sa.Column("listen_count", sa.Integer(), nullable=False),
        *[
            sa.Column(name, sa.DateTime(), nullable=True)
            for name in (
                "first_clicked_at",
                "last_clicked_at",
                "first_listened_at",
                "last_listened_at",
            )
        ],
    )
    op.create_table(
        "audio_links",
        sa.Column(
            "song_id", sa.Integer(), sa.ForeignKey("songs.id", ondelete="CASCADE"), primary_key=True
        ),
        sa.Column("url", sa.Text(), nullable=False),
        sa.Column("headers", sa.JSON(), nullable=False),
        sa.Column("resolved_at", sa.DateTime(), nullable=False),
        sa.Column("expires_at", sa.DateTime(), nullable=True),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("audio_kind", sa.String(20), nullable=False),
        sa.Column("last_error", sa.Text(), nullable=True),
    )
    op.create_table(
        "playback_sessions",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "song_id", sa.Integer(), sa.ForeignKey("songs.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("client_request_id", sa.String(36), nullable=False, unique=True),
        sa.Column("state", sa.String(20), nullable=False),
        sa.Column("counted", sa.Boolean(), nullable=False),
        sa.Column("refresh_count", sa.Integer(), nullable=False),
        sa.Column("link_version", sa.Integer(), nullable=False),
        sa.Column("audio_kind", sa.String(20), nullable=False),
        sa.Column("error_code", sa.String(60), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("expires_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_playback_sessions_song_id", "playback_sessions", ["song_id"])
    op.create_table(
        "provider_cache",
        sa.Column("key", sa.String(300), primary_key=True),
        sa.Column("value", sa.JSON(), nullable=False),
        sa.Column("expires_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )


def downgrade():
    for table in ("provider_cache", "playback_sessions", "audio_links", "song_stats", "songs"):
        op.drop_table(table)
