# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS frontend-build
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

FROM python:3.13-slim-bookworm AS runtime
LABEL org.opencontainers.image.authors="DataShare"
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1 \
    UV_PYTHON_DOWNLOADS=never

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && pip install --no-cache-dir "uv==0.13.7" \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY pyproject.toml uv.lock README.md THIRD_PARTY_LICENSE_MUSICDL.txt ./
COPY alembic.ini ./
COPY migrations/ ./migrations/
COPY src/ ./src/
RUN uv sync --locked --no-dev --no-cache

COPY --from=frontend-build /app/frontend/dist ./frontend/dist
RUN mkdir -p /app/data \
    && useradd --create-home --uid 10001 app \
    && chown -R app:app /app

ENV MUSIC_DATABASE_URL=sqlite+aiosqlite:///data/music.db \
    MUSIC_CATALOG_TARGET=100 \
    MUSIC_PROVIDER_CONCURRENCY=2 \
    MUSIC_FULL_AUDIO_VERIFY_CONCURRENCY=1

USER app
EXPOSE 10000
# Use the preinstalled environment directly, without syncing dependencies at startup
CMD ["sh","-c","exec /app/.venv/bin/uvicorn music.app:app --host 0.0.0.0 --port \"${PORT:-10000}\" --workers 1"]
