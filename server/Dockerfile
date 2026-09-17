# GrocerEZ sync API. Runs with tsx (no separate build step) since this is a
# small server; see docs/server-sync-plan.md section 13.
#
# Build from the REPO ROOT (not this directory) so shared/ is in the build
# context: `docker build -f server/Dockerfile -t grocerez-server .`
# docker-compose.yml's `context: ..` does this automatically.
#
# The image mirrors the monorepo's layout (/app/shared next to
# /app/server) rather than flattening it, so relative imports from server
# code into shared/ (e.g. "../../shared/price.js") resolve exactly the way
# they do outside Docker.

FROM node:20-alpine AS deps
WORKDIR /app/server
COPY server/package.json server/package-lock.json* ./
RUN npm ci --omit=dev && npm install --no-save tsx@^4.19.2

FROM node:20-alpine AS runtime
RUN apk add --no-cache dumb-init
ENV NODE_ENV=production
WORKDIR /app/server

COPY --from=deps /app/server/node_modules ./node_modules
COPY server/package.json ./
COPY server/tsconfig.json ./
COPY server/drizzle ./drizzle
COPY server/src ./src
COPY shared /app/shared

EXPOSE 8787
VOLUME ["/data"]
ENV DATABASE_PATH=/data/grocerez.db

ENTRYPOINT ["dumb-init", "--"]
CMD ["node_modules/.bin/tsx", "src/index.ts"]
