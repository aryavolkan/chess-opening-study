# syntax=docker/dockerfile:1
# Self-contained image: Node 22 (for the built-in SQLite module), the app and
# its vendored engine/board packages. Analysis and the study set live in the
# /data volume so they survive upgrades.
FROM node:22-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY data/openings.tsv data/
COPY public/ public/
COPY server/ server/
COPY shared/ shared/
COPY scripts/ scripts/

RUN mkdir -p /data && chown node:node /data
USER node

ENV HOST=0.0.0.0 \
    PORT=3000 \
    DB_PATH=/data/study.sqlite
VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
