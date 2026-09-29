# Forgeboard: one image, no database container, no external service.
# Node 22.5+ is required for the node:sqlite standard-library driver.
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV FORGEBOARD_DB_PATH=/data/forgeboard.db
ENV FORGEBOARD_UPLOAD_DIR=/data/uploads

RUN addgroup -S forge && adduser -S forge -G forge

COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/.next        ./.next
COPY --from=build /app/public       ./public
COPY package.json ./
COPY lib          ./lib
COPY scripts      ./scripts
COPY fixtures.json ./
COPY docker-entrypoint.sh ./

RUN mkdir -p /data && chown -R forge:forge /data /app && chmod +x docker-entrypoint.sh
USER forge
VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["./docker-entrypoint.sh"]
