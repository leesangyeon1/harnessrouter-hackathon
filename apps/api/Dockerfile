# syntax=docker/dockerfile:1
# Production image for finance_api (FastAPI service, private Cloud Tasks worker, and Cloud Run Jobs).
# Build from repository root:
#   docker build -f apps/api/Dockerfile -t finance-api:local .

FROM python:3.12-slim-bookworm AS builder

COPY --from=ghcr.io/astral-sh/uv:0.6.14 /uv /usr/local/bin/uv

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never

WORKDIR /app

# Copy workspace manifests first for layer caching
COPY pyproject.toml uv.lock .python-version ./
COPY apps/api/pyproject.toml apps/api/pyproject.toml
COPY packages/finance-core/pyproject.toml packages/finance-core/README.md packages/finance-core/
COPY packages/quant-worker/pyproject.toml packages/quant-worker/pyproject.toml

# Install third-party dependencies only
RUN uv sync --locked --no-dev --package finance-api --no-install-workspace

# Copy source packages and install non-editable wheels into /app/.venv
COPY packages/finance-core/src packages/finance-core/src
COPY packages/quant-worker/src packages/quant-worker/src
COPY apps/api/src apps/api/src

RUN uv sync --locked --no-dev --package finance-api --no-editable


FROM python:3.12-slim-bookworm AS runtime

RUN groupadd --gid 10001 finance && \
    useradd --uid 10001 --gid 10001 --create-home --shell /usr/sbin/nologin finance

WORKDIR /app

COPY --from=builder --chown=finance:finance /app/.venv /app/.venv

ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PORT=8080

USER 10001:10001
EXPOSE 8080
STOPSIGNAL SIGTERM

CMD ["sh", "-c", "exec uvicorn finance_api.app:app_from_env --factory --host 0.0.0.0 --port \"${PORT:-8080}\" --timeout-graceful-shutdown 25 --no-access-log"]
