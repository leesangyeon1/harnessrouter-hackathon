FROM node:22-bookworm-slim AS deps
WORKDIR /app/apps/admin
COPY apps/admin/package.json apps/admin/package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM node:22-bookworm-slim AS builder
WORKDIR /app/apps/admin
COPY --from=deps /app/apps/admin/node_modules ./node_modules
COPY apps/admin/ ./
ARG NEXT_PUBLIC_IDENTITY_PROJECT_ID
ARG NEXT_PUBLIC_FIREBASE_API_KEY
ARG NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN
ARG NEXT_PUBLIC_CUSTOMER_URL
ENV NEXT_TELEMETRY_DISABLED=1 \
    NEXT_PUBLIC_IDENTITY_PROJECT_ID=$NEXT_PUBLIC_IDENTITY_PROJECT_ID \
    NEXT_PUBLIC_FIREBASE_API_KEY=$NEXT_PUBLIC_FIREBASE_API_KEY \
    NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=$NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN \
    NEXT_PUBLIC_CUSTOMER_URL=$NEXT_PUBLIC_CUSTOMER_URL
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=8080
COPY --from=builder --chown=node:node /app/apps/admin/.next/standalone ./
COPY --from=builder --chown=node:node /app/apps/admin/.next/static ./apps/admin/.next/static
COPY --from=builder --chown=node:node /app/apps/admin/public ./apps/admin/public
USER node
EXPOSE 8080
CMD ["node", "apps/admin/server.js"]
