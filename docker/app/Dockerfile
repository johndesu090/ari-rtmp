# ── Ari RTMP — application image (API + dashboard + P2P tracker) ───────
FROM node:20-bookworm-slim

WORKDIR /app

# Prisma needs OpenSSL; curl is handy for health/debug.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY prisma ./prisma
RUN npx prisma generate

COPY src ./src
COPY public ./public

COPY docker/app/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV NODE_ENV=production
EXPOSE 3000

ENTRYPOINT ["/entrypoint.sh"]
