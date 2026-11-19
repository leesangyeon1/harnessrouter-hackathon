# syntax=docker/dockerfile:1
# Production image for the unified Next.js application (Customer UI + Admin Ops UI).
# Requires `output: "standalone"` in apps/web/next.config.{js,mjs,ts}.
# Build from repository root once apps/web is merged:
#   docker build -f deploy/docker/web.Dockerfile \
#     --build-arg NEXT_PUBLIC_API_BASE_URL=https://api.example.com \
#     --build-arg NEXT_PUBLIC_IDENTITY_PROJECT_ID=my-gcp-project \
#     --build-arg NEXT_PUBLIC_FIREBASE_API_KEY=... \
#     --build-arg NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=... \
#     -t finance-web:local .

FROM node:22-bookworm-slim AS deps
WORKDIR /app

# Support either standalone apps/web lockfile or root workspace lockfile
COPY apps/web/package.json apps/web/package-lock.json* ./apps/web/
WORKDIR /app/apps/web
RUN npm ci --no-audit --no-fund


FROM node:22-bookworm-slim AS builder
WORKDIR /app/apps/web

COPY --from=deps /app/apps/web/node_modules ./node_modules
COPY apps/web/ ./
COPY deploy/scripts/verify_bundle_secrets.sh /usr/local/bin/verify_bundle_secrets.sh

# Public browser variables ONLY. Never pass Plaid, Alpaca, HarnessRouter, or DB secrets here.
ARG NEXT_PUBLIC_API_BASE_URL
ARG NEXT_PUBLIC_IDENTITY_PROJECT_ID
ARG NEXT_PUBLIC_FIREBASE_API_KEY
ARG NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN

ENV NEXT_TELEMETRY_DISABLED=1 \
    NODE_ENV=production \
    NEXT_PUBLIC_API_BASE_URL=${NEXT_PUBLIC_API_BASE_URL} \
    NEXT_PUBLIC_IDENTITY_PROJECT_ID=${NEXT_PUBLIC_IDENTITY_PROJECT_ID} \
    NEXT_PUBLIC_FIREBASE_API_KEY=${NEXT_PUBLIC_FIREBASE_API_KEY} \
    NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=${NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN}

RUN npm run build && \
    chmod +x /usr/local/bin/verify_bundle_secrets.sh && \
    /usr/local/bin/verify_bundle_secrets.sh --frontend-bundle .next/static public


FROM node:22-bookworm-slim AS runtime
WORKDIR /app

RUN groupadd --gid 10001 nextjs && \
    useradd --uid 10001 --gid 10001 --create-home --shell /usr/sbin/nologin nextjs

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=8080

COPY --from=builder --chown=nextjs:nextjs /app/apps/web/public ./apps/web/public
COPY --from=builder --chown=nextjs:nextjs /app/apps/web/.next/standalone ./
COPY --from=builder --chown=nextjs:nextjs /app/apps/web/.next/static ./apps/web/.next/static

USER 10001:10001
EXPOSE 8080
STOPSIGNAL SIGTERM

CMD ["sh", "-c", "if [ -f apps/web/server.js ]; then exec node apps/web/server.js; else exec node server.js; fi"]
