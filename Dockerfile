ARG PYTHON_IMAGE=public.ecr.aws/docker/library/python:3.13-slim-bookworm

FROM public.ecr.aws/docker/library/python:3.13-slim-bookworm AS runtime
LABEL org.opencontainers.image.authors="DataShare"
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1 \
    UV_PYTHON_DOWNLOADS=never

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates libcap2-bin \
    && pip install --no-cache-dir "uv==0.13.7" \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY pyproject.toml uv.lock README.md .env.example THIRD_PARTY_LICENSE_MUSICDL.txt ./
COPY alembic.ini ./
COPY migrations/ ./migrations/
COPY src/ ./src/
RUN uv sync --locked --no-dev --no-cache

RUN useradd --create-home --uid 10001 app \
    && chown -R app:app /app \
    && setcap cap_net_bind_service=+ep "$(readlink -f /app/.venv/bin/python)"

ENV PORT=80 \
    MUSIC_DATABASE_URL=mysql+asyncmy://music:REPLACE_IN_CLOUD_CONSOLE@10.17.106.21:3306/music?charset=utf8mb4 \
    MUSIC_AUTO_MIGRATE=false \
    MUSIC_WECHAT_APP_ID=wxe1af0ed55ed257b7

USER app
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD ["/app/.venv/bin/python", "-m", "music.healthcheck"]
CMD ["sh","-c","exec /app/.venv/bin/uvicorn music.app:app --host 0.0.0.0 --port \"${PORT:-80}\" --workers 1 --no-proxy-headers"]
