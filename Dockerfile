# Forgeboard runs on Node's standard library (node:http, node:sqlite, node:crypto) and nothing else.
# There is no npm install and no build step, so once the base image is cached this builds and
# runs with the network off.
FROM node:24-alpine

ENV NODE_ENV=production \
    FORGEBOARD_PORT=8080 \
    FORGEBOARD_DB_PATH=/data/forgeboard.db \
    FORGEBOARD_FIXTURES=/app/fixtures.json

WORKDIR /app
COPY package.json fixtures.json ./
COPY src ./src
COPY static ./static
RUN mkdir -p /data && chown node:node /data

USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.ts"]
