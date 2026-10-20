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

The client and API share `grocerez.app`, split by DNS record: the apex
(or `www`) points at Netlify, `api.grocerez.app` points at the droplet.
`Caddyfile` already has `api.grocerez.app` filled in.

1. **Add an A record** for `api.grocerez.app` pointing at the droplet's
   IP (`162.243.163.217`). Let's Encrypt (which Caddy uses automatically)
   cannot issue a certificate for a bare IP address, so this step isn't
   optional. The apex/`www` record pointing at Netlify is separate --
   follow Netlify's own domain instructions for that one.
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
   cp .env.example .env
   # fill in ADMIN_TOKEN, mail, Stripe/OpenRouter keys, and set
   # CORS_ORIGINS=https://grocerez.app,http://localhost:5173
   # APP_URL=https://grocerez.app
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
6. **Bring the stack up:**
   ```bash
   mkdir -p data
   chown 1000:1000 data       # api container runs as the non-root "node" user
   docker compose up -d --build
   ```
   First boot takes a few minutes while Overpass imports the extract and
   Caddy requests its certificate for `api.grocerez.app`. `docker compose
   logs -f` shows both.
7. **Point the client at it**: set `VITE_SYNC_API_URL=https://api.grocerez.app`
   when building/deploying the client (see the root `README.md`).

## Dev API on the VPS

For deploy previews and Stripe test mode you want a backend that is not
production, without running a second server all the time. The `api-dev`
service in `docker-compose.yml` is that: same image as `api`, but behind a
Compose profile so it only exists when you start it, with its own database,
admin token, and Stripe **test** keys. Day-to-day work needs none of this --
`npm run dev` (see Local development) runs everything on your machine.

One-time setup:

1. **DNS:** add an A record for `dev-api.grocerez.app` pointing at the droplet
   (the Caddyfile already has the block).
2. **Fill in the `DEV_*` values** in `server/.env` (see `.env.example`):
   Stripe *test-mode* key, price id (a $1.99 test price), and webhook secret;
   `DEV_NETLIFY_SITE_SLUG` (the part of your preview addresses after the `--`,
   e.g. `deploy-preview-22--<slug>.netlify.app`); and a stable
   `DEV_APP_URL`, such as a Netlify branch-deploy address, for Stripe to
   return to. Leave the production `NETLIFY_SITE_SLUG` empty so production
   never accepts previews.
3. **Data directory:** `mkdir -p data-dev && chown 1000:1000 data-dev`.
4. **Stripe (test mode):** add a webhook endpoint at
   `https://dev-api.grocerez.app/api/billing/webhook` with the four events
   listed under "Turning on subscriptions"; its secret is
   `DEV_STRIPE_WEBHOOK_SECRET`.
5. **Netlify:** scope `VITE_SYNC_API_URL` per context -- Production:
   `https://api.grocerez.app`; Deploy Previews and Branch deploys:
   `https://dev-api.grocerez.app`. Redeploy the preview afterwards, since the
   value is baked in at build time.

Using it:

```bash
docker compose --profile dev up -d --build api-dev   # start (and rebuild after pulling new code)
docker compose logs -f api-dev                       # sign-in codes print here (MAIL_PROVIDER=console)
docker compose stop api-dev                          # stop; costs nothing while stopped
```

If you'd rather just leave it running, that's fine (`restart: unless-stopped`
brings it back after a reboot; idle it uses about 100 MB). Then deploy both
together with `docker compose --profile dev up -d --build`: a plain
`docker compose up -d --build` skips profile services, so `api-dev` would keep
running the old code.

While it is stopped, previews can't sign in or load community prices (the
site itself still works). Running `docker compose up -d` without the profile
never starts it, so production deploys are unaffected. To reset dev data,
stop it and delete `data-dev/`. Don't copy the production database into it:
that file holds real email addresses.

## Turning on subscriptions

Shared prices are free for the most popular items in your area and need either a
subscription ($1.99/month) or earned credits for everything else (plan section
6.3). Everything below is off until you do it: with `ENTITLEMENTS_ENFORCED=false`
(the default) every user sees every price, and checkout answers 503 until the
Stripe settings exist. Do it in Stripe's **test mode** first -- the test keys,
a test price, and a test webhook all work the same way -- and repeat the
steps with live ones once a test purchase works end to end.

1. **Create the price once.** Stripe Dashboard > Product catalog > Add product:
   "GrocerEZ shared prices", $1.99 USD, recurring, monthly. Copy its `price_...`
   id into `STRIPE_PRICE_ID`. (This id is not a secret, but the server also
   refuses to start a checkout if the id is not an active $1.99 USD monthly
   price, so a wrong id can never charge the wrong amount.)
2. **Create an API key and put it in `STRIPE_API_KEY`.** Dashboard > Developers >
   API keys > *Create restricted key*, with these permissions and nothing else:
   Customers **write**, Checkout Sessions **write**, Customer portal **write**,
   Prices **read**. A restricted key can't touch your payouts or other products
   if it ever leaks. Keep the key only in `server/.env` on the VPS (it is
   gitignored); never commit it, and never put it in the client.
3. **Add the webhook.** Developers > Webhooks > Add endpoint:
   `https://api.grocerez.app/api/billing/webhook`, listening for
   `checkout.session.completed`, `customer.subscription.created`,
   `customer.subscription.updated` and `customer.subscription.deleted`. Copy
   its signing secret (`whsec_...`) into `STRIPE_WEBHOOK_SECRET`. A test-mode
   key only receives test-mode events and a live key only live ones, so make
   the webhook in the same mode as the key.
4. **Turn on the customer portal** (Settings > Billing > Customer portal) with
   "Customers can cancel subscriptions" enabled. The app's "Manage
   subscription" button opens it.
5. **Set the rest and restart:**
   ```bash
   # in server/.env
   STRIPE_API_KEY=rk_live_...
   STRIPE_PRICE_ID=price_...
   STRIPE_WEBHOOK_SECRET=whsec_...
   APP_URL=https://grocerez.app
   ENTITLEMENTS_ENFORCED=true
   docker compose up -d
   ```
6. **Try it** with a test-mode purchase (card `4242 4242 4242 4242`) before going
   live: subscribe in the app, confirm "You're subscribed" appears after the
   redirect, open "Manage subscription", and cancel.

How access is decided:

| Level | How a user gets it | What lasts |
|---|---|---|
| subscriber | An active (or trialing, or past-due) Stripe subscription | Until the period end Stripe reports, plus a 3-day grace for a late renewal webhook. A subscription with no recorded period end grants nothing. |
| contributor | Redeeming **200 credits** for one free month | 30 days; redemptions stack |
| public | Everyone else | The free-tier products only; the rest show as locked teasers |

Credits: each verified, non-redundant price report earns 10 credits (at most 10
such reports a day). Credits expire 90 days after they are earned. Redeeming is
manual (`POST /api/billing/redeem-credits`, the "Redeem" button) and is
refused while subscribed, so paying users don't burn credits on a month they
already have. An upheld flag revokes the credit its report earned, but never
claws back a month that was already redeemed.

Operating notes:

- Webhooks are idempotent and order-safe: Stripe's event id is recorded once, an
  event older than the newest one already applied is skipped, and a canceled
  subscription can never be reactivated by a late event. If applying an event
  fails the server answers 500 and Stripe retries it.
- Test events sent to a live key (and vice versa) are logged and ignored.
- Stripe's dashboard > Webhooks > the endpoint shows every delivery and lets you
  resend one; replays are harmless.
- To stop charging for a user by hand, cancel the subscription in Stripe; the
  `customer.subscription.deleted` event ends their access. Editing `users.plan`
  in SQLite is not a substitute -- the next webhook overwrites it.

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
