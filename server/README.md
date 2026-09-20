# GrocerEZ sync API

Backend for shared price-report sync (`docs/server-sync-plan.md`). Fully
separate from the Netlify-hosted client: own `package.json`, own
dependencies, own deploy. The only thing it shares with the client is the
`shared/` folder one level up (pure TypeScript, no dependencies), which both
sides import by relative path.

## Status

This is the Phase 1 skeleton: project setup, the full data model as
migrations, and a health check. Auth, push/pull, and product matching are
not built yet -- see `docs/server-sync-plan.md` section 14 for what's next.

## Local development

```bash
cd server
cp .env.example .env      # defaults are fine for local dev
npm install
npm run dev                # tsx watch; migrations run automatically on start
```

The server listens on `http://localhost:8787` (`PORT` in `.env`).
`GET /healthz` and `GET /api/db-check` confirm it's up and the database is
reachable.

## Database

SQLite via `better-sqlite3` + Drizzle ORM. The schema lives in
`src/db/schema.ts`; migrations are generated from it into `drizzle/` and are
checked into git (they are the source of truth for what's been deployed,
not something to regenerate on every machine).

```bash
npm run db:generate   # after changing src/db/schema.ts, writes drizzle/000N_*.sql
npm run db:migrate     # apply pending migrations to $DATABASE_PATH directly
```

Migrations also run automatically every time the server starts
(`src/db/migrate.ts` is called from `src/index.ts`), so a normal deploy
never needs the manual step above -- it's there for CI or one-off checks.

## Tests

```bash
npm test          # vitest run, once
npm run test:watch
```

Tests use an in-memory or temp-file SQLite database per test (see
`src/db/__tests__/migrate.test.ts` and `src/__tests__/app.test.ts`), never
the `data/` directory, so they don't touch anything you're running locally.

## Docker / Compose

Build context is the **repo root**, not this directory, because the image
needs `shared/` too:

```bash
# from the repo root
docker compose -f server/docker-compose.yml build
docker compose -f server/docker-compose.yml up -d
```

`docker-compose.yml`'s `context: ..` handles this for you; if you build the
image directly with `docker build`, point it at the repo root:

```bash
docker build -f server/Dockerfile -t grocerez-server .
```

The stack is `api` + self-hosted `overpass` + `caddy` (reverse proxy and
automatic HTTPS) -- see "Deploying to a VPS" below for the full sequence.

Note: this Dockerfile has been reviewed but not build-verified from this
session -- the environment's egress proxy blocks Docker Hub's CDN by
policy. Run the build once yourself before deploying; if it fails, the
most likely culprit is the `better-sqlite3` native build needing build
tools inside the `node:20-alpine` image (it has them via `node-gyp`'s
bundled toolchain, but confirm on your machine's architecture).

## Deploying to a VPS

For a cheap VPS (DigitalOcean, Hetzner, etc.) instead of a home box --
see `docs/server-sync-plan.md` section 13.1 for the tradeoffs. No
Cloudflare Tunnel needed here: a VPS already has a public, static IP, so
Caddy handles HTTPS directly instead.

1. **Point a domain at the droplet.** Add an A record for the domain (or
   subdomain) you'll use for the API, pointing at the droplet's IP.
   Let's Encrypt (which Caddy uses automatically) cannot issue a
   certificate for a bare IP address, so this step isn't optional. A free
   DNS provider like DuckDNS works fine if you don't own a domain.
2. **SSH into the droplet** and run the one-time OS setup (Docker, the
   Compose plugin, and a firewall allowing only 22/80/443):
   ```bash
   sudo ./server/deploy/setup.sh
   ```
3. **Copy this repo onto the droplet** (`git clone` if the repo is
   reachable from there, otherwise `scp`/`rsync` the working tree).
4. **Configure the server:**
   ```bash
   cd server
   cp .env.example .env   # fill in ADMIN_TOKEN, mail, Stripe/OpenRouter keys, etc.
   ```
5. **Fetch a regional Overpass extract**, clipped to keep the import
   inside a small droplet's RAM:
   ```bash
   ./deploy/fetch-overpass-extract.sh
   ```
   Defaults to a Dallas-Fort Worth bounding box; pass your own
   `minlon,minlat,maxlon,maxlat` as an argument, or see the script's
   comments for using an unclipped state extract once you've upgraded to
   a bigger droplet.
6. **Set your domain in `Caddyfile`**, replacing the `api.example.com`
   placeholder.
7. **Bring the stack up:**
   ```bash
   docker compose up -d --build
   ```
   First boot takes a few minutes while Overpass imports the extract and
   Caddy requests its certificate. `docker compose logs -f` shows both.
8. **Point the client at it**: set `VITE_SYNC_API_URL` to
   `https://<your-domain>` when building/deploying the client (see the
   root `README.md`).

## Backups

Once deployed, back up the SQLite file, not just the Docker volume:

```bash
sqlite3 /data/grocerez.db ".backup /data/backup/grocerez-$(date +%F).db"
```

See `docs/server-sync-plan.md` section 13.3 for the scheduled version of
this (nightly cron + `rclone` to object storage).

## Layout

```
server/
  src/
    index.ts          entry point: runs migrations, starts the HTTP server
    app.ts             Hono app factory (routes, CORS) -- takes its db as a
                        parameter so tests can use an isolated in-memory one
    env.ts             environment variable parsing, one place
    db/
      schema.ts        Drizzle table definitions (source of truth)
      client.ts        opens a SQLite file/`:memory:` and wraps it in Drizzle
      migrate.ts        applies drizzle/*.sql; also the `db:migrate` script
  drizzle/              generated SQL migrations (checked in)
  Dockerfile
  docker-compose.yml
```

Route modules (`src/routes/auth.ts`, `sync.ts`, `products.ts`, `flags.ts`,
`admin.ts`) and services (`src/services/stores.ts`, `products.ts`, `trust.ts`,
`freshness.ts`) don't exist yet -- they're added as each part of the plan in
section 14 is implemented.
