# Price Report Server Sync: Implementation Plan

Status: **draft for review**. Nothing in this document is implemented yet.

## 1. Goal

Let every GrocerEZ user upload their price reports to a shared server and pull
down everyone else's, so that searching for "eggs" shows prices from stores
the user has never scanned themselves. Three problems make this harder than a
plain backup:

1. **Identity of items.** Two scans of the same product at different stores
   (or by different users) produce slightly different `itemName`, `brand`,
   `tags`, and occasionally different `quantity_units`. We need to decide when
   two reports describe the same product.
2. **Trust.** Anyone can upload anything, including a price written on a
   sheet of paper. We need to know who reported what, let users flag bad
   reports, and let the system stop trusting users who produce them.
3. **Freshness.** Prices go stale, and sale prices expire. Newer reports
   should win, and reports past their expiration should stop being presented
   as current.

Constraints from the request:

- The backend must be completely separate from the Netlify-hosted frontend.
  It lives in its own subdirectory (`server/`) with its own dependencies,
  build, and deployment.
- No image similarity. Matching uses item name, brand, size, tags, and price
  plausibility only.
- Keep the existing JSON export/import working.

## 2. Current state of the app (what the plan builds on)

| Fact | Where | Consequence |
|---|---|---|
| Reports are stored in `localStorage` as an array; edit/delete use the array index | `src/App.tsx` | Reports need a stable client-generated `id` before they can be synced or referenced by a flag |
| `PriceData` has no author, no id, no sync state | `src/PriceData.ts` | Schema grows a few optional fields; a load-time migration fills them in |
| `price` is a string like `"2.99"` or `"$2.99"`; `date` is `YYYY-MM-DD` | `src/App.tsx`, `src/PriceScanner.tsx` | Server stores integer cents and an ISO date; client normalizer already handles the `$` |
| `store` is `"Name @ Street Address"` from Overpass/Nominatim, plus optional `latitude`/`longitude` | `src/PriceScanner.tsx` | Store matching can key on chain name + location; the address is a fallback |
| Search tokenizes name + brand + tags and uses a prefix-match rule | `src/searchUtils.ts` | Product matcher reuses `tokenize` and the prefix rule as its first layer |
| The benchmark defines unit equivalence (64 fl oz == 0.5 gal, 1 lb == 16 oz; count-like units are not interchangeable) | `benchmark/ground_truth.json` `_policy` | Same rules become the size-comparison step of the matcher |
| Images are stripped from `localStorage` and from exports | `src/App.tsx` | Phase 1 syncs no images; photo evidence is an optional later phase |
| The OpenRouter key ships in the client bundle as `VITE_OPENROUTER_API_KEY` | `src/parsePriceImage.ts` | Out of scope, but once a server exists it is the natural place to proxy that call. Noted in Phase 4 |

## 3. Architecture overview

```
 Phone / browser (React + Vite, hosted on Netlify)
 ┌────────────────────────────────────────────────────┐
 │ localStorage                                        │
 │   priceData      = my reports  (editable, synced)   │
 │   communityData  = others' reports (read-only cache)│
 │   syncState      = { token, userId, cursor, queue } │
 │                                                     │
 │ Search = filterBySearchQuery(mine ∪ community)      │
 └───────────────▲───────────────────────┬────────────┘
                 │ pull (since cursor)   │ push (batch, idempotent by id)
                 │                       ▼
 ┌────────────────────────────────────────────────────┐
 │ server/  (Node + Hono + SQLite, deployed separately)│
 │   auth        anonymous device accounts            │
 │   ingest      validate → resolve store → resolve   │
 │               product → anomaly checks → store     │
 │   moderation  flags, confirmations, trust scoring  │
 │   read model  current price per (product, store)   │
 └────────────────────────────────────────────────────┘
```

Design choice: **offline-first pull-and-cache**, not server-side search. The
app works offline today, and the community dataset will be small for a long
time (thousands of reports at ~300 bytes each). The client pulls changed
reports incrementally and searches locally. If the dataset outgrows
`localStorage`, geo-scoped pulls (Phase 3) shrink it without changing the
protocol.

## 4. Backend stack and layout

Recommendation: **Node 20+, TypeScript, Hono, Drizzle ORM, SQLite (better-sqlite3)**.

- Hono is small, TypeScript-first, and runs unchanged on Node, Bun, or
  Cloudflare Workers if hosting preferences change.
- Drizzle gives typed schema + migrations, and the SQLite driver can be
  swapped for Postgres later without rewriting queries.
- SQLite in a single file is trivial to run locally, trivial to back up, and
  more than enough for this scale. Deploy on Fly.io or Railway with a
  persistent volume, or any VPS.

```
grocerez-web/
├── src/                     # existing client (unchanged location)
├── shared/                  # NEW: pure TS, no deps, imported by both sides
│   ├── normalize.ts         # tokenize, singularize, stopwords, brand canon
│   ├── units.ts             # unit families + conversion
│   ├── matching.ts          # product similarity scoring
│   └── types.ts             # wire types for the sync API
├── server/                  # NEW: standalone backend
│   ├── package.json         # own deps, own scripts, own lockfile
│   ├── tsconfig.json
│   ├── Dockerfile
│   ├── drizzle/             # migrations
│   └── src/
│       ├── index.ts         # Hono app + listener
│       ├── db/schema.ts
│       ├── auth.ts
│       ├── routes/{auth,sync,reports,products,flags,admin}.ts
│       ├── services/{stores,products,trust,freshness}.ts
│       └── *.test.ts
└── docs/server-sync-plan.md # this file
```

`shared/` is inside the Vite root, so the client imports it directly; the
client `tsconfig.app.json` and the server tsconfig both include it. The
existing `tokenize` in `src/searchUtils.ts` moves there and is re-exported so
current imports and tests keep working.

## 5. Data model (server)

All ids are UUIDs. Times are ISO-8601 UTC. Money is integer cents, USD only
for now (`currency` column present, defaulted, not yet exposed).

**users**
- `id`, `created_at`, `display_name` (optional), `token_hash`
- `trust_score` (float, cached; recomputed by the trust service)
- `status`: `active` | `restricted` | `banned`
- counters: `reports_count`, `confirmed_count`, `upheld_flags_count`

**stores**
- `id`, `name` (chain/display name, e.g. "Kroger"), `address`, `lat`, `lon`
- `geohash7` (about 150 m cell) for blocking
- `store_key`: normalized name + geohash7, or name + address when no coordinates

**products** (canonical item clusters)
- `id`, `canonical_name`, `brand_key`, `size_family`, `size_base_qty`, `size_label`
- `tags` (JSON), `report_count`, `median_price_cents` (cached)
- `merged_into` (nullable): manual merge target; readers follow the chain
- `possible_duplicate_of` (nullable): matcher grey-zone hint for review

**product_tokens** (inverted index for candidate lookup)
- `product_id`, `token`

**price_reports**
- `id` (client-generated), `user_id`, `product_id`, `store_id`, `seq` (server-assigned monotonically increasing integer; the sync cursor)
- as reported: `item_name`, `brand`, `tags` (JSON), `quantity`, `quantity_units`, `price_cents`, `price_raw`
- `observed_date` (the scan date), `expires_at` (nullable; sale end date), `is_sale` (bool)
- `source`: `scan` | `manual` | `import`
- `status`: `active` | `hidden` | `deleted`; `review_reason` (nullable: `price_outlier`, `flagged`, `new_user`)
- `confirm_count`, `flag_weight` (cached)
- `created_at`, `updated_at`, `deleted_at`

**report_votes**
- `id`, `report_id`, `user_id`, `kind`: `confirm` | `flag`
- `reason` (flags only): `wrong_price` | `wrong_item` | `expired` | `duplicate` | `spam` | `other`
- `note`, `created_at`, `resolution` (nullable: `upheld` | `dismissed`), `resolved_at`
- unique on (`report_id`, `user_id`)

**current_prices** (read model, maintained on write)
- (`product_id`, `store_id`) → `report_id`, `price_cents`, `observed_date`, `expires_at`, `confidence`, `is_stale`

## 6. Identity and auth

Recommendation for Phase 1: **anonymous device accounts**.

- When the user turns on sync, the client calls `POST /api/auth/anonymous`
  and receives `{ userId, token }`. The token is stored in `localStorage`
  and sent as `Authorization: Bearer`. The server stores only a hash.
- Optional display name; otherwise reports show as "Shopper 4f2a".
- The token is included in the JSON export so restoring a backup restores
  identity. (Trade-off: the backup file becomes sensitive. Flag for review.)
- Phase 3 adds email linking via magic link for recovery and multi-device.

This is deliberately low-friction, which means identities are cheap to
create. The trust system (section 9) is designed so that a fresh identity
has very little influence, and rate limits are applied per IP as well as per
user. It does not fully prevent Sybil attacks; if that becomes a real
problem, email or OAuth accounts are the next step.

## 7. Sync protocol

Client-side additions to `PriceData` (all optional so old data still loads):

```ts
id: string;            // UUID, generated on create or on first load (migration)
userId?: string;       // author; undefined for pre-sync local reports until first push
origin: 'mine' | 'community';
productId?: string;    // assigned by server after push
storeId?: string;
expiresAt?: string;    // YYYY-MM-DD, sale end date
isSale?: boolean;
syncedAt?: string;     // last successful push of this version
updatedAt: string;
deletedAt?: string;    // tombstone until the delete is pushed
```

Push: `POST /api/sync/push` with `{ reports: PriceReportUpsert[] }`.
- Idempotent by `id`. Server upserts when the caller is the author; rejects
  otherwise.
- Tombstones (`deletedAt` set) soft-delete on the server.
- Response returns, per id, `{ productId, storeId, seq, status, normalized }`
  so the client can display the canonical product name and know whether the
  report was held for review.
- Only the author's edits are accepted; last write by `updatedAt` wins for
  that author's own report (multi-device case).

Pull: `GET /api/sync/pull?since=<seq>&limit=500` (later: `&lat=&lon=&radiusKm=`).
- Returns reports with `seq > since`, including hidden/deleted state changes
  so the client can drop them from its cache, plus the author's trust tier
  and vote counts. Returns `nextSince`. Client loops until caught up.
- Community reports are cached in a separate `localStorage` key and are
  read-only in the UI.

Triggers: on app load, after a save/edit/delete, on a manual "Sync now"
button, and when `navigator.onLine` flips to true. Failed pushes stay in a
queue and retry with backoff.

JSON import: imported reports get ids, `origin: 'mine'`, and are pushed like
any other local report.

## 8. Product matching ("are these the same item?")

Implemented as pure functions in `shared/matching.ts` with tests, so the
client can later reuse it to suggest matches at scan time.

### 8.1 Normalization

1. **Name tokens**: `tokenize` (existing) → drop stopwords (`the, a, an, of,
   with, and, in, for, by`) → singularize with a small rule set
   (`cookies→cookie`, `berries→berry`, `boxes→box`, trailing `s` unless
   `ss`) → apply a short synonym table (`fl oz→fluid ounce`, `pkg→package`,
   `ct→count`). The LLM prompt already expands most abbreviations, so this
   table stays small.
2. **Brand key**: same normalization; plus a canonical map for store brands
   (`365 by whole foods market→365`, `great value`, `kirkland
   signature→kirkland`, `good & gather`). Blank brand is "unknown", not a
   mismatch.
3. **Size**: `(quantity, quantity_units)` → `(family, base_qty)`:
   weight → grams, volume → milliliters, `count` → count. Count-like labels
   (`package`, `pack`, `box`, `can`, `roll`, `tissue`) stay as their own
   family with the label kept; `pack≈package` is the only alias. The parser
   default of `1 unit` is treated as unknown.
4. **Tags**: tokenized, low weight.

### 8.2 Candidate lookup (blocking)

Products where all of the following hold:
- `brand_key` equal, or either side unknown;
- `size_family` equal (or either unknown);
- at least one shared non-generic name token, via `product_tokens`.

This keeps scoring to a handful of candidates per report.

### 8.3 Scoring

```
nameSim   = Dice coefficient over name token sets, where two tokens match if
            equal, or one is a prefix of the other and the shorter is ≥ 4 chars
            (the existing search rule, tightened with the length floor)
brand     = 1.0 equal | 0.5 one unknown | 0.0 different
size      = hard requirement: base_qty within 3% when both known;
            mismatch rejects the candidate (12 ct eggs ≠ 18 ct eggs)
tagSim    = Dice over tag tokens
pricePen  = 0.15 if product has ≥ 3 reports and price/median is outside
            [0.35, 3.0]; else 0. Never a veto (the "$4 apples for $1" case).

score = 0.65·nameSim + 0.20·brand + 0.15·tagSim − pricePen
```

Decision:
- `score ≥ 0.80` → attach to that product.
- `0.60 ≤ score < 0.80` → create a new product with `possible_duplicate_of`
  set, so an admin (or later, users) can merge.
- `< 0.60` → new product.

A brand mismatch (`brand = 0`) rejects the candidate unless the brand word
appears in the other side's name tokens (handles `brand: "Oreo"` vs
`itemName: "Oreo Double Stuf", brand: ""`).

Thresholds are starting points. Section 12 describes the labeled fixture
used to tune them.

### 8.4 Manual merge and split

- `POST /api/admin/products/:id/merge-into/:targetId` sets `merged_into`,
  re-points `current_prices`, and re-indexes tokens. Reversible by clearing
  the pointer.
- A `wrong_item` flag that is upheld detaches the report and re-runs matching
  with the flagged product excluded.
- Phase 2 UX: at save time the client calls `GET /api/products/match`
  with the parsed fields and shows "Is this the same as *Stok Cold Brew
  Coffee 48 fl oz* (seen at 2 stores)?" with a one-tap yes/no. Human
  confirmation at the source is the cheapest way to make clustering good.

### 8.5 Store matching

`store_key` = normalized chain name (text before ` @ `) + geohash7 when
coordinates exist; otherwise chain name + normalized address. Two reports
within about 250 m with the same chain name resolve to the same store. No
fuzzy matching on store names beyond normalization; Overpass returns
consistent names for the same location.

## 9. Trust, flagging, and moderation

### 9.1 What is recorded

Every report carries `user_id`. Every vote carries the voter's `user_id`.
Nothing is anonymous server-side, even though users are anonymous to each
other.

### 9.2 Trust score

Recomputed for a user whenever one of their reports gains a confirmation or
an upheld flag, and nightly for tenure.

```
confirmed   = reports with ≥ 1 confirmation from a distinct user, or
              active and unflagged for ≥ 14 days
bad         = reports with an upheld flag
trust       = (confirmed + 1) / (confirmed + 3·bad + 2)     // Laplace-smoothed
tier        = new        if reports_count < 3
            | restricted if trust < 0.35
            | established if trust < 0.75
            | trusted    otherwise
```

Tier is what the client shows ("unverified" badge for `new`/`restricted`).

### 9.3 Votes

- **Confirm** ("I saw this price too"): positive signal for the report and
  the author; refreshes the report's freshness (section 10).
- **Flag** with reason. Flag weight = voter's trust score (a `new` user's
  flag counts ~0.33; a `trusted` user's ~0.9). When `flag_weight ≥ 1.5`
  from ≥ 2 distinct users, the report becomes `hidden` with
  `review_reason = flagged` and disappears from pulls. Authors cannot vote
  on their own reports.
- A hidden report stays hidden until an admin resolves it (`upheld` →
  author's `bad` count increments; `dismissed` → report restored, flaggers'
  flags marked dismissed, which feeds *their* trust downward if it happens
  repeatedly).

### 9.4 Automatic checks at ingest

- Price sanity: parses to a positive amount ≤ $10,000.
- Outlier: if the product has ≥ 3 reports and the price is outside
  `[0.25×, 4×]` the median, the report is stored `active` with
  `review_reason = price_outlier` and shows an "unusual price" hint in the
  client. Not hidden, because real sales exist.
- Duplicate collapse: same author, same product, same store, same
  `observed_date` → update the existing report instead of inserting.
- Rate limits: 60 reports/hour/user, 200/hour/IP, 30 votes/hour/user.
- `restricted` users' new reports are `hidden` with
  `review_reason = new_user` until an admin or two confirmations release them.
- `banned` users get 403 on push; their existing reports are hidden.

### 9.5 Admin

Phase 2 ships JSON admin endpoints protected by an `ADMIN_TOKEN` env var:
list open flags, resolve a flag, merge products, change a user's status. A
small admin page can come later; a CLI script (`npm run admin -- flags`)
is enough to start.

## 10. Freshness, expiration, and override

- `observed_date` is the scan date; `expires_at` is optional and set from
  the tag's "sale ends" date when visible. The OpenRouter prompt gets two
  new fields (`saleEndDate`, `isSale`) and the details form gets a date
  field. Regular-price tags leave `expires_at` empty.
- **Current price** for a (product, store) is the newest `active` report by
  `observed_date`, with one exception: if the newest is from a `new` or
  `restricted` author and an older report (≤ 30 days older) from an
  `established`+ author disagrees by more than 15%, both are returned and
  the client shows the trusted one first with the newer one as "reported
  $X on <date> (unverified)".
- **Stale**: `expires_at` passed, or `observed_date` older than 45 days
  with no confirmation since. Stale reports remain in history and in pulls
  but are ranked below fresh ones and rendered dimmed with the date. They
  are not deleted.
- A newer report at the same store supersedes older ones in
  `current_prices`; older ones remain in `price_reports` and are available
  via `GET /api/products/:id/prices` for a history view.
- A confirmation on a report bumps its freshness reference date to the
  confirmation date, so a regular price that has not changed does not go
  stale just because nobody rescanned it.

## 11. API surface

```
POST   /api/auth/anonymous                 → { userId, token }
PATCH  /api/me                             { displayName }
GET    /api/me                             → profile, tier, counts

POST   /api/sync/push                      { reports: [...] } → per-id results
GET    /api/sync/pull?since=&limit=        → { reports, nextSince }

GET    /api/products/match?itemName=&brand=&quantity=&quantityUnits=
                                           → top candidates with scores   (Phase 2)
GET    /api/products/:id/prices            → current per store + history

POST   /api/reports/:id/confirm
POST   /api/reports/:id/flag               { reason, note }
DELETE /api/reports/:id/vote

GET    /api/admin/flags?status=open         (ADMIN_TOKEN)
POST   /api/admin/flags/:id/resolve         { resolution }
POST   /api/admin/products/:id/merge-into/:targetId
PATCH  /api/admin/users/:id                 { status }
```

CORS is restricted to the Netlify origin and `localhost` in dev. All
inputs validated with `zod`; the same schemas generate the shared wire types.

## 12. Testing

- **Matcher fixture**: a labeled file `shared/__fixtures__/product-pairs.json`
  of (report A, report B, sameProduct: true/false) built from the real
  export plus the search test data. Cases to include: the two Oreo
  variants (different products), Stok Cold Brew at two stores (same),
  Great Value vs Eggland's Best eggs (different brand, same size), 12 ct
  vs 18 ct eggs (size mismatch), blank-brand vs filled-brand of the same
  item, and the sale-price outlier. The thresholds in 8.3 are tuned until
  this fixture passes; it is the regression suite from then on.
  **I need the real export file for this.** It did not arrive with the
  request; committing a sanitized copy (no lat/lon if you prefer) under
  `shared/__fixtures__/` would be ideal.
- **Server**: Vitest with an in-memory SQLite database. Route tests for
  push idempotency, author-only edits, pull cursoring, flag thresholds,
  and trust recomputation.
- **Client**: tests for the id migration, the sync queue reducer, and
  search over `mine ∪ community` (existing `searchUtils.test.ts` extended).
- **Existing tests** must keep passing after `tokenize` moves to `shared/`.

## 13. Deployment and operations

- `server/Dockerfile` (multi-stage, node:20-alpine). `fly.toml` or Railway
  config with a mounted volume for `data/grocerez.db`.
- Env: `PORT`, `DATABASE_PATH`, `ADMIN_TOKEN`, `CORS_ORIGINS`.
- Backups: nightly `sqlite3 .backup` to object storage, or Litestream
  streaming replication if on Fly.
- Client: `VITE_SYNC_API_URL` env var; sync features hidden when unset so
  the current Netlify deploy is unaffected until the server is live.
- Logging: request logs + a counter of hidden reports and open flags, so
  abuse is visible without an admin UI.

## 14. Phases

**Phase 0: groundwork (client only, no server yet)**
- Add `id`/`updatedAt`/`origin` to `PriceData` with a load-time migration;
  switch edit/delete from array index to id.
- Extract `tokenize` and the prefix rule into `shared/normalize.ts`; add
  `shared/units.ts` from the benchmark's unit policy. All tests green.
- Scanner and edit form gain optional `isSale` and `expiresAt` fields; the
  prompt asks for `saleEndDate`.

**Phase 1: sync works between two devices**
- `server/` skeleton: Hono, Drizzle, SQLite, migrations, Dockerfile.
- Anonymous auth, push, pull, store resolution, product matching (8.1–8.3),
  `current_prices` maintenance.
- Client: sync settings screen (enable, display name, sync now, last
  synced), background sync triggers, community cache, search over both
  sets, read-only rendering of community reports with author tier and date.
- Deliverable: scan on phone A, see the price on phone B.

**Phase 2: trust and moderation**
- Votes (confirm/flag), trust scoring, hide threshold, ingest checks, rate
  limits, admin endpoints + CLI.
- Client: confirm/flag buttons, "unverified"/"unusual price"/"stale" badges,
  current-vs-history price view per product.
- Save-time product match prompt (8.4).

**Phase 3: scale and recovery**
- Geo-scoped pulls; email linking for account recovery; product merge
  review page; price history chart on the product view.

**Phase 4: optional, discussed but not committed**
- Photo evidence: upload the price-tag photo with a report so flag review
  has something to look at. Not image similarity, just storage. Needs an
  object store and a size cap.
- Move the OpenRouter call behind the server so the API key leaves the
  client bundle, and so the server can rate-limit parsing per user.

## 15. Decisions I need from you

1. **Auth level for Phase 1**: anonymous device accounts (recommended, above)
   vs. requiring an email up front.
2. **Hosting**: Fly.io / Railway / a box you already have. This only
   changes the deploy files.
3. **Include the sync token in JSON exports** so a restored backup keeps the
   same identity? Convenient, but the backup becomes a credential.
4. **Pull scope**: everything (simplest, fine for now) vs. geo-scoped from
   day one.
5. **Flavor variants**: the benchmark policy notes flavors of the same
   product line usually share a price. Should the matcher merge them into
   one product (fewer clusters, occasional wrong merge) or keep them
   separate (recommended to start; merge later by hand if it is noisy)?
6. **The real export file** for the matcher fixture (section 12).
7. **Phase 4 items**: worth planning now, or park them?
