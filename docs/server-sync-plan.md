# Price Report Server Sync: Implementation Plan

Status: **Phases 0 and 1 implemented** on branch `claude/price-report-server-sync-2k2iup`; section 14 records what each phase shipped and what it deliberately left out. Phases 2-4 are still the plan as written.

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
- Sync is the feature that will eventually be paid for, so it requires an
  email account; local use and scanning do not.

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
| The OpenRouter key shipped in the client bundle as `VITE_OPENROUTER_API_KEY` | `src/parsePriceImage.ts` | Fixed in Phase 3: the call moved behind `POST /api/parse` once the server existed to proxy it |

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
 │   auth        email + code sign-in, device tokens  │
│   geo         nearby stores (own Overpass behind it)│
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

**users** (additional columns, from section 6)
- `email` (unique, lowercased), `plan`, `plan_expires_at`, `home_lat`, `home_lon`

**auth_codes**: `email`, `code_hash`, `expires_at`, `attempts`

**sessions**: `id`, `user_id`, `token_hash`, `created_at`, `last_seen_at`, `expires_at`

**devices**: `id`, `token_hash`, `user_id` (nullable until sign-in), `created_at`, `last_seen_at`

**subscriptions**: `user_id`, `provider`, `provider_ref`, `status`, `current_period_end`

**free_tier_products**: `region_key`, `product_id`, `rank`, `entered_at`, `computed_at`

**contribution_credits**: `user_id`, `report_id`, `earned_at`, `revoked_at`

**stores**
- `id`, `name` (chain/display name, e.g. "Kroger"), `address`, `lat`, `lon`
- `chain_key` (normalized, aliased chain name); `is_chain_level` (true when
  the store has no location, see 8.5)
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

## 6. Identity, auth, and entitlements

Decision (yours): **syncing requires an email account; scanning and local
use do not.** Sync is the monetized feature, so the account is also where
entitlement (free trial vs. paid) is tracked.

### 6.1 Sign-in: email + one-time code

Passwordless, code-based rather than link-based:

1. Client `POST /api/auth/request-code { email }`. Server creates a
   6-digit code (hashed, 10-minute expiry, 5 attempts) and emails it.
2. User types the code. Client `POST /api/auth/verify { email, code }`
   → `{ userId, sessionToken, entitlement }`.
3. Session token (random 256-bit, hashed at rest, 90-day sliding expiry)
   goes in `localStorage` and in `Authorization: Bearer`.

Why a code and not a magic link: on phones the link often opens in the
default browser rather than the installed PWA, and the app's navigation is
`history.pushState` with no URL routing, so a link would need new routing
just to land. A code is typed into the app the user is already in.

Email delivery: Resend (free tier covers thousands/month) with a
`MAIL_PROVIDER=console` mode in dev that prints the code to the server log.
Provider is behind one interface so it can be swapped.

Signing in on a second device is the same flow, so **account recovery is
inherent** as long as the user still controls the email. Recovery for a lost
mailbox is deferred (Phase 4).

### 6.2 Device identity for anonymous users

Users who never sign in still use the server: they pull the free tier
(6.3) and, from Phase 3, every scan they take runs through the AI-parse
proxy and costs money. So the client keeps a **device token**
(`POST /api/devices/register`, no email) that identifies the device for
free-tier pulls, per-device daily parse caps (your item 9), and abuse
control. Signing in links the device to the account. No reports or votes
are accepted from a device token alone.

### 6.3 Entitlements: a public free tier plus a subscription

Decision (yours, item 11): the free experience must work for people who
never sign in, and it is limited to the **top 20–30 products**; everything
else needs a subscription.

Three access levels, checked on every pull:

| Level | Who | What pull returns |
|---|---|---|
| `public` | Device token only, no email | Full reports for products in the free set; for every other product a **locked summary** (product name, size, how many stores and reports nearby, newest date) with no prices |
| `contributor` | Signed in, earned access this month (6.3.2) | Everything |
| `subscriber` | Signed in, active Stripe subscription | Everything |

Signed-in users without a subscription or contributor credit get the
`public` level; signing in by itself unlocks pushing, voting, and earning
credit, not the full dataset. Push always requires sign-in because trust
scoring, flag resolution, and contributor credit all need a durable
identity. Push is never gated by payment.

The locked summaries are the upsell: searching "olipop" as a public user
shows "4 prices at 3 stores near you, newest 2 days ago" with a subscribe
button instead of nothing. The server never sends a locked price, so the
client cannot be patched around it.

#### 6.3.1 The free set

- `free_tier_products` (`region_key`, `product_id`, `rank`, `computed_at`),
  recomputed nightly per region (the same 0.1° cell + radius key as the
  pull cursor) by `distinct_reporters × distinct_stores` over the last 90
  days, taking the top `FREE_TIER_PRODUCT_COUNT` (default 25).
- Ranking by reporters × stores rather than raw report count keeps one
  user's repeated scans of the same item from dominating the free set.
- A product stays in the set for at least 7 days after entering it so the
  free tier does not visibly churn day to day.
- Early on, when a region has fewer than 25 products, the free set is
  simply everything there, which is the right behavior for a dataset that
  needs seeding.
- Alternative kept in reserve: a curated staples list by tag (`milk`,
  `eggs`, `bread`, `bananas`). Not chosen because tags are not products;
  it can be layered on as a manual override column later.

#### 6.3.2 Contributor credit (item 10)

Verified, non-redundant reports earn access without paying. A report earns
one credit only when **all** of these hold:

- **Non-redundant**: it is the first report for its (product, store) pair
  in the last 30 days, or its price differs from the pair's current price
  by at least 5%. A second scan of the same shelf tag the same week earns
  nothing. Reports collapsed by the duplicate rule in 9.4 earn nothing.
- **Verified**: it has a confirmation from a distinct user, or it has been
  active and unflagged for 14 days. Credit is therefore always delayed by
  up to two weeks, which is also how long a spammer has to wait to find
  out their reports earned nothing.
- **From a user in good standing**: trust tier `established` or better,
  and the report is not `hidden` or `price_outlier`.
- **Under the daily cap**: at most `CREDIT_DAILY_CAP` (default 10) credits
  per user per day, so bulk uploads of a fabricated list cannot buy a year
  of access in an afternoon.

`contribution_credits` (`user_id`, `report_id`, `earned_at`, `revoked_at`).
A user has `contributor` access for any month in which they hold at least
`CREDITS_PER_MONTH` (default 15) unrevoked credits earned in the trailing
30 days. An upheld flag revokes the credit and re-evaluates access on the
next pull. The account screen shows "12 of 15 credits this month" so the
incentive is visible.

#### 6.3.3 Subscription

- `users.plan`: `free` | `paid`; `users.plan_expires_at`.
- `subscriptions`: `user_id`, `provider` (`stripe`), `provider_ref`,
  `status`, `current_period_end`. Written by a Stripe webhook in Phase 3.
- Gating is behind a single `ENTITLEMENTS_ENFORCED` flag, off in Phase 1
  and 2 so the seed users see everything, on in Phase 3 with Stripe.

### 6.4 Data the server holds about a person

Email (unique, lowercased), hashed session tokens, hashed codes, report and
vote history, the device tokens linked to the account, and later a Stripe
customer id. No passwords. Export/delete endpoints for the account are
listed in Phase 4.

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

Pull: `GET /api/sync/pull?since=<seq>&lat=&lon=&radiusMi=50&limit=500`.
Geo-scoped from day one (your decision 4).
- Authenticated by a session token or a device token; the access level
  (6.3) decides whether prices outside the free set are returned or
  replaced by locked summaries. The response carries `accessLevel` so the
  client can render the right badges and upsell.
- `lat`/`lon` are required; `radiusMi` defaults to 50 and is capped at 100.
- Returns reports whose resolved store lies inside the circle and whose
  `seq > since`, including hidden/deleted state changes so the client can
  drop them from its cache, plus the author's trust tier and vote counts.
  Returns `nextSince`. Client loops until caught up.
- The cursor is stored per **region key** (center rounded to 0.1°, plus
  radius). Moving to a new region starts a fresh cursor and a fresh cache
  for that region; the client keeps at most two regions cached.
- Where the client gets `lat`/`lon`: the device's current position if
  granted (the scanner already asks); else the coordinates of the user's
  most recent located report; else a home area the user sets once in the
  sync settings (a zip code or city, geocoded through the server's geo
  proxy in section 8.6). Pull is skipped with a visible "set your area"
  hint if none of these exist.
- Reports at chain-level stores (no coordinates, see 8.5) carry an
  `approx` location: the centroid of the reporter's located reports in the
  same 7-day window, else the reporter's home area. They are included in
  the pull when that approximate point is inside the circle and are shown
  with a "location approximate" hint.
- Community reports are cached in a separate `localStorage` key and are
  read-only in the UI. Locked summaries are cached alongside them (names
  and counts only) so search can show the teaser offline.
- Server-side the filter is a bounding-box prequery on `stores.lat/lon`
  (indexed) followed by a haversine check. SQLite handles this fine at
  this scale; no spatial extension needed.

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
- **Flavor-variant rule** (your decision 5): when both brands are known and
  match, and both sizes are known and match, the attach threshold drops to
  `0.55`. This merges "Buldak Spicy Ramen (Rose)" and "Buldak Spicy Ramen,
  Artificial Spicy Chicken Flavor" (same brand, same 24.65 oz) into one
  product while still keeping "Oreo Double Stuf 2.71 oz" apart from the
  11.18 oz BTS pack. Each report keeps its own `item_name`, so the variant
  is never lost; the product's `canonical_name` is the token intersection
  ("Buldak Spicy Ramen"), and the client shows "3 variants" when names
  differ. Clearance pricing on one flavor shows up as a per-store price
  report like any other and is subject to the outlier hint; if that turns
  out to be noisy, a `variant_key` column can split pricing per variant
  later without re-clustering.
- `0.60 ≤ score < 0.80` (or `0.40 ≤ score < 0.55` under the flavor rule)
  → create a new product with `possible_duplicate_of` set, so an admin (or
  later, users) can merge.
- Below that → new product.

A brand mismatch (`brand = 0`) rejects the candidate unless the brand word
appears in the other side's name tokens (handles `brand: "Oreo"` vs
`itemName: "Oreo Double Stuf", brand: ""`).

**Produce gets no special treatment (decision 8, reversed).** The original
answer to decision 8 was yes: treat brand as a soft signal for produce, so
18 oz blueberries from six packers cluster into one product. That was
implemented and tested in Phase 1, and it worked as scored -- but it broke
`current_prices`, which is keyed by `(product_id, store_id)` only, with no
brand or variant dimension. Two brands merged into one product at the same
store would fight over that single "current price" slot: whichever was
scanned more recently would silently overwrite the other's price in the
summary view, even though a shopper standing at the shelf sees two
genuinely different prices side by side. Fixing that properly means widening
`current_prices`' key to include brand or a general `variant_key` -- more
schema and query machinery than the search-clustering benefit was worth.
Produce is now scored exactly like everything else: a brand mismatch
rejects the candidate, full stop. Different-brand blueberries are different
products, the same way Great Value and Eggland's Best eggs are.

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

### 8.6 Geo proxy (Overpass and Nominatim behind the API)

You are standing up your own Overpass instance because the public one rate
limited the app. The client currently calls `overpass-api.de` and
`nominatim.openstreetmap.org` directly from `src/PriceScanner.tsx`. Once the
API exists, those calls move behind it:

- `GET /api/geo/nearby-stores?lat=&lon=` → `[{ storeId?, name, address,
  lat, lon, distanceM }]`. The server first answers from its own `stores`
  table (anything within 150 m that it has seen before), and only falls
  through to Overpass for unknown locations. Results are written back to
  `stores`, so Overpass traffic drops toward zero for stores anyone has
  scanned at before.
- `GET /api/geo/reverse?lat=&lon=` and `GET /api/geo/geocode?q=` wrap
  Nominatim for the home-area setting (section 7). Cached by rounded
  coordinates.
- Overpass runs on a regional extract (Texas is a few GB; the whole US is
  workable on a home box), which is another reason to keep it next to the
  API rather than in a cloud VM with metered disk.
- The client falls back to the public endpoints only when the API is
  unreachable and the sync feature is off, so anonymous users are not
  broken by an API outage.

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
POST   /api/devices/register               → { deviceToken }
POST   /api/auth/request-code              { email }
POST   /api/auth/verify                    { email, code } → { userId, sessionToken, entitlement }
POST   /api/auth/signout
PATCH  /api/me                             { displayName, homeLat, homeLon }
GET    /api/me                             → profile, tier, counts, entitlement
                                             (entitlement includes credits: { earned,
                                              needed } directly -- no separate
                                              /api/me/credits endpoint; nothing else
                                              needed one)

POST   /api/sync/push                      { reports: [...] } → per-id results
GET    /api/sync/pull?since=&lat=&lon=&radiusMi=&limit=
                                           → { accessLevel, reports, locked, nextSince }
                                             (device token or session; never 402,
                                              locked prices are omitted instead)

GET    /api/geo/nearby-stores?lat=&lon=    → stores table first, Overpass fallback
GET    /api/geo/reverse?lat=&lon=
GET    /api/geo/geocode?q=

POST   /api/parse                          { priceImage, productImage, reportId? }
                                           → parsed fields (device token or session;
                                             JSON with base64 data URLs, not
                                             multipart -- the client already had
                                             those from the canvas capture)
GET    /api/reports/:id/photo              → the price-tag photo, if any (author
                                             or admin token only)
POST   /api/billing/checkout               → Stripe Checkout URL (session required;
                                             503 until STRIPE_SECRET is set)
POST   /api/billing/webhook                (Stripe → server; 503 until
                                             STRIPE_WEBHOOK_SECRET is set)

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

## 11a. What the real export shows (148 reports, 2025-04 to 2026-09)

The export is committed at `shared/__fixtures__/price-reports-sample.json`
and becomes the raw input for the matcher fixture. Reading it changed several
details above; the refinements are listed here and folded into the phases.

**Store strings are much messier than the `Name @ Address` form.**
Of 35 distinct store strings, only 12 have the chain + address form.
The rest are bare chain names with trailing whitespace (`"Kroger "`, 47 of
the 148 reports are some spelling of Kroger with no address), bare addresses
with no chain (`"9410 Webb Chapel Road"`, which is the same Walmart as
`"Walmart Supercenter @ 9410 Webb Chapel Road"`), literal `"undefined"` from
a reverse-geocode miss (`"undefined La Cima"`), and chain spelling variants
(`HEB` / `H-E-B`, `Walmart` / `Walmart Supercenter`, `Halal Imports` /
`Halal Import Foods`). Refinements to section 8.5:
- Store resolution gets a normalization step: trim, drop `undefined`
  fragments, split on ` @ `, and map the chain through a small alias table
  (`heb→h-e-b`, `walmart supercenter→walmart`, `kroger marketplace→kroger`).
- A report with only a chain name resolves to a **chain-level store**
  (`Walmart`, no location). The `current_prices` view and the client group
  by chain when location is unknown, so "Walmart $1.47" and "Walmart
  Supercenter @ Webb Chapel $1.47" for the same eggs show as one chain with
  a located and an unlocated entry rather than two unrelated stores.
- A report with an address or coordinates but no chain name resolves by
  geohash to an existing named store at that location when one exists
  (the 11 `9410 Webb Chapel Road` reports attach to the Walmart there).
- The `store` field the client sends is not changed by any of this; the
  server records the raw string and the resolved `store_id`.

**Prices need a parser, and the outlier check earns its keep.**
Seven of 148 prices are not `d.dd`: `$10`, `$19.7`, `548` (a missed decimal
point, really $5.48), `3/10.00` twice (a multi-buy the older prompt did not
divide), `$1 off`, and `6.5`. Refinements to section 9.4:
- Server-side `parsePrice`: strip `$`, accept `d`, `d.d`, `d.dd`; convert
  `N/X.XX` and `N for X.XX` to `X.XX / N`; reject anything else (`$1 off`)
  with a per-item error the client shows as "fix the price to sync this".
- Integers ≥ 100 with no decimal point are accepted but flagged
  `price_outlier` when the product median says they are 100× off; the
  client offers a one-tap "did you mean $5.48?" correction.
- The 18 oz spinach at `$19.7` (surely $1.97) and 8-pack mints at `$14.77`
  are exactly the honest-mistake case the outlier flag is for. They are
  stored, shown as "unusual price", and de-ranked, not hidden.

**Units are inconsistent in case, plurality, and punctuation.**
33 distinct unit strings for what is roughly 12 real units: `oz`, `OZ`,
`Oz`, `OZ.`, `ounce`; `lb`, `lbs`, `LBS`, `pound`; `gal`, `gallon`,
`GALLONS`; plus free text (`X 10 OZ`, `LB 4 0Z`, `284-sheet rolls`,
`fruit ice bars`, `bags`, `rolls`). Refinements to section 8.1:
- `shared/units.ts` lowercases, strips trailing periods and plural `s`,
  then maps through an alias table. Unrecognized strings become
  `family: unknown`, which the matcher treats as "size not known" rather
  than as a mismatch, so old reports still cluster on name + brand.
- `rolls`, `bags`, `can`, `bottle`, `pack`, `package`, `each`, `count`
  are all count-like. `count`, `each`, `pack`, `package`, `ct` are treated
  as one family; the others keep their label (6 rolls ≠ 6 count).

**Brand handling needs three tweaks.** Real pairs that should match:
`"Acne Foaming Wash" / PanOxyl` vs `"PanOxyl 10% Foam Acne Foaming Wash" /
PanOxyl`; `"Classic Macaroni and Cheese" / Annie's Homegrown` vs `"Natural
Classic Macaroni and Cheese" / Annie's`; `"Cold Brew Coffee" / Stok` vs
`"Unsweetened Cold Brew Coffee" / Stok`. Refinements to section 8.3:
- Remove the brand's tokens from the name tokens before computing
  `nameSim`, so a brand repeated in the name neither helps nor hurts.
- Brands match when one brand's token set is a subset of the other's
  (`annies` ⊂ `annies homegrown`, `clif` ⊂ `clif bar`, `clif kid`).
- 11 reports have an empty brand; they stay "unknown", never a mismatch.

**Known misses to accept for now** (the Phase 2 save-time prompt is the fix):
- `"Z Bar Crafted Specially for Active Kids"` vs `"Z Bar Whole Grain
  Bars"` (same 36-ct Sam's Club item, $18.68 both): name overlap too low.
- `"Clif ZBar …"` vs `"Z Bar …"`: `ZBar` tokenizes as one token. A
  synonym entry (`zbar→z bar`) is cheap but does not generalize.
- `"Ferrero Collection Fine Assorted Confections"` vs `"Ferrero Collection
  With Raffaello"`: probably the same 4.6 oz box, scored as different.
- `"Buldak Spicy Ramen (Rose)"` vs `"Buldak Spicy Ramen, Artificial Spicy
  Chicken Flavor"` lands in the grey zone; decision 5 in section 15 decides
  whether flavor variants should merge.

**Produce is six separate products, by design.** Blueberries appear under
six brands (Driscoll's, Simple Truth Organic, Field & Vine, Berry Fresh,
Twin River, California Giant) at 18 oz or 1 pint. With brand as a hard
constraint (decision 8, reversed -- see section 8.3) these are six
products. A shopper comparing "blueberries 18 oz" across brands is a
search/display concern for the client to solve (grouping products by
name+size in results), not a reason to merge them into one product server
side and lose per-brand pricing.

**Same-store history already exists in the data.** Great Value 2% milk at
Webb Chapel is $2.76 on 2026-05-29 and $2.96 on 2026-06-14; Stok cold brew
at Kroger on 07-31 and 08-23. These are the "newer report supersedes" cases
from section 10 and go straight into the fixture.

**Size.** 148 reports serialize to 36 KB. Pull-everything is fine for a long
time; even 10,000 community reports would be about 2.5 MB, well inside
`localStorage` limits.

## 12. Testing

- **Matcher fixture**: a labeled file `shared/__fixtures__/product-pairs.json`
  of (report A, report B, sameProduct: true/false) built from the real
  export plus the search test data. Cases to include: the two Oreo
  variants (different products), Stok Cold Brew at two stores (same),
  Great Value vs Eggland's Best eggs (different brand, same size), 12 ct
  vs 18 ct eggs (size mismatch), blank-brand vs filled-brand of the same
  item, the PanOxyl / Annie's / Stok pairs from section 11a, the
  blueberry-brand cases, and the sale-price outlier. The thresholds in 8.3
  are tuned until this fixture passes; it is the regression suite from
  then on. The raw export is already committed at
  `shared/__fixtures__/price-reports-sample.json`; the labeled pairs file
  is derived from it in Phase 0.
- **Store resolution fixture**: the 35 distinct store strings from the
  export, labeled with the expected chain and whether they should share a
  `store_id`.
- **Price parser fixture**: the seven odd price strings from the export
  plus the normal forms.
- **Server**: Vitest with an in-memory SQLite database. Route tests for
  push idempotency, author-only edits, pull cursoring, flag thresholds,
  and trust recomputation.
- **Client**: tests for the id migration, the sync queue reducer, and
  search over `mine ∪ community` (existing `searchUtils.test.ts` extended).
- **Existing tests** must keep passing after `tokenize` moves to `shared/`.

## 13. Deployment and operations

### 13.1 Hosting comparison

You have a home machine with good bandwidth that will host Overpass anyway,
so the real question is whether the sync API runs there too.

| | Home box + Cloudflare Tunnel | Fly.io | Railway | Cheap VPS (Hetzner, DO) |
|---|---|---|---|---|
| Monthly cost | $0 (tunnel is free) | ~$5–10 with a volume | ~$5–10 | ~$5 |
| Overpass next to the API | Yes, same Compose file | No (disk is expensive) | No | Possible but 40+ GB disk costs extra |
| Public HTTPS + dynamic IP | Tunnel handles both, no port forwarding | Built in | Built in | Caddy + a domain |
| Uptime | Tied to home power, ISP, and reboots | Managed | Managed | Managed VM, you patch it |
| Latency for users elsewhere | Fine for a regional app | Multi-region | Single region | Single region |
| Backups | You script them (see below) | Volume snapshots | Snapshots | You script them |
| Move later | Compose file moves as-is | Fly-specific config | Railway-specific | Compose file moves as-is |

Recommendation: **start on the home box** with a single Docker Compose
stack (`api`, `overpass`, `cloudflared`), because Overpass already forces
that box to exist and the tunnel removes the networking pain. Structure
`server/` so the API container has no dependency on being co-located with
Overpass beyond an `OVERPASS_URL` env var. If home uptime becomes a
problem, the API container and its SQLite file move to a $5 VPS in an
afternoon, and Overpass stays home behind the same tunnel.

### 13.2 Layout

- `server/Dockerfile` (multi-stage, `node:20-alpine`).
- `server/docker-compose.yml`: `api` (volume `./data:/data`), `overpass`
  (`wiktorn/overpass-api` image with the regional extract), `cloudflared`
  (tunnel token from env).
- Env: `PORT`, `DATABASE_PATH`, `ADMIN_TOKEN`, `CORS_ORIGINS`,
  `MAIL_PROVIDER`, `RESEND_API_KEY`, `MAIL_FROM`, `OVERPASS_URL`,
  `NOMINATIM_URL` (public Nominatim is fine at these volumes; self-host
  only if it also rate limits), later `OPENROUTER_API_KEY`,
  `STRIPE_SECRET`, `STRIPE_WEBHOOK_SECRET`, `PHOTO_DIR`.
- Client: `VITE_SYNC_API_URL`; sync UI is hidden when unset so the current
  Netlify deploy is unaffected until the server is live.

### 13.3 Backups and ops

- Nightly `sqlite3 /data/grocerez.db ".backup /data/backup/…"` plus
  `rclone` to Backblaze B2 or S3 (a few cents a month). Photos (Phase 3)
  go to the same bucket. Restore is documented in `server/README.md` and
  tested once before launch.
- Litestream is the upgrade if you want continuous replication instead of
  nightly snapshots; it runs as a sidecar in the same Compose file.
- Health endpoint `GET /healthz`; an external ping (UptimeRobot free tier)
  tells you when the home box is down.
- Request logs plus counters for hidden reports, open flags, 402s, and
  parse-proxy spend per day, so abuse and cost are visible without an
  admin UI.

## 14. Phases

**Phase 0: groundwork (client only, no server yet)** — done on this branch.
Notes from implementation: `shared/` holds `normalize.ts`, `units.ts`,
`price.ts`, and `ids.ts` with fixture-backed tests; `normalizePriceData`
moved to `src/normalizePriceData.ts` so the id migration is tested against
the real export; the benchmark prompt in `benchmark/scripts/run_benchmark.py`
was deliberately left unchanged (it would change published results) and
now lags the app prompt by the two sale sentences.
- **To do:** update `benchmark/scripts/run_benchmark.py` (and re-run) to
  cover the new `isSale`/`saleEndDate` fields, so the benchmark prompt and
  scoring catch up to the app prompt and stop drifting.
- Add `id` / `updatedAt` / `origin` to `PriceData` with a load-time
  migration; switch edit/delete from array index to id.
- Extract `tokenize` and the prefix rule into `shared/normalize.ts`; add
  `shared/units.ts` and `shared/price.ts` (the parser from 11a) with the
  fixtures from section 12. All existing tests green.
- Scanner and edit form gain optional `isSale` and `expiresAt`; the prompt
  asks for `saleEndDate`.

**Phase 1: sync works between two devices**
- `server/` skeleton: Hono, Drizzle, SQLite, migrations, Dockerfile,
  Compose with `cloudflared`; deployed on the home box. — **skeleton done**
  on this branch (project setup, tests, and Docker; auth/push/pull/matching
  below are not built yet). Notes from implementation: the full data model
  from sections 5/6 is in `server/src/db/schema.ts` and migrated via
  Drizzle; `server/src/app.ts` takes its database as a parameter so tests
  run against an isolated in-memory SQLite instance rather than a shared
  file; `health`/`db-check` endpoints and CORS are the only routes so far.
  `drizzle-orm`/`drizzle-kit` were pinned above the versions in an npm
  advisory for SQL-identifier escaping (`GHSA-gpj5-g38j-94v9`) rather than
  the versions originally planned. The Dockerfile mirrors the monorepo's
  layout inside the image (`/app/shared` next to `/app/server`) instead of
  flattening it, so the relative imports server code will make into
  `shared/` resolve the same way they do outside Docker; it is reviewed but
  not build-verified from this session because this sandbox's network
  policy blocks Docker Hub's image CDN -- run `docker build` once yourself
  before deploying. Overpass and the Cloudflare Tunnel are commented out in
  `docker-compose.yml` until a regional extract and a tunnel token exist.
- Email + code sign-in (6.1), device registration (6.2) — **done** on this
  branch: `POST /api/auth/request-code` and `/verify` (10-minute code,
  5 attempts, 60-second resend cooldown, 90-day session), `POST
  /api/devices/register`, and `GET`/`PATCH /api/me` (profile, trust tier,
  and a not-yet-enforced entitlement summary). Notes from implementation:
  `resolveSession`/`resolveDevice` share one `Authorization: Bearer`
  header, checked as a session first and a device token second, via
  `requireAuth`/`requireUser` middleware; `server/src/services/trust.ts`
  implements the section 9.2 formula early since `/api/me` needed a tier to
  report, though `confirmedCount`/`upheldFlagsCount` stay at zero until
  Phase 2's voting exists; the 6-digit code is hashed with `scrypt` (a
  slow hash, since 5 attempts and a 10-minute expiry are a thinner defense
  than for a 256-bit token) while session and device tokens use `sha256`
  (fast is fine at that entropy); linking an anonymous device to an
  account on sign-in (`linkDeviceToUser`) is implemented but not yet
  called from a route, since nothing consumes it until push/pull exist.
  Verified with 37 passing tests (unit, service, and route-level through
  the live Hono app) and a live smoke test of the full request-code →
  verify → `/api/me` → sign-out flow. Entitlement tables and the
  free-set job (6.3) do not exist yet -- `/api/me`'s entitlement summary is
  a placeholder (`enforced: false`) until Phase 3.
- Push, geo-scoped pull (anonymous devices included), store resolution
  with chain aliases and chain-level stores, product matching with the
  flavor rule, `current_prices` maintenance. — **done** on this branch:
  `POST /api/sync/push` and `GET /api/sync/pull`, plus the matcher and
  store resolver they call. Notes from implementation:
  - The scoring formula itself (`shared/matching.ts`) is pure and
    dependency-free per the plan's own file layout, so the client can
    reuse it later (section 8.4's save-time prompt) without pulling in
    anything server-specific. `server/src/services/products.ts` is only
    the orchestration: candidate lookup via `product_tokens`, calling into
    `shared/matching.ts` for the score, and the create/attach/review
    write path.
  - **The produce rule was implemented, found to have a real problem, and
    then reversed -- not by a bug in the code, but by a bug in the design
    it was carrying out.** First pass: as specified (brand scored 0.5,
    flavor-variant threshold-lowering keyed only on `brandsKnownAndEqual`),
    six differently-branded blueberry packers landed in `review`, not
    `attach`; that got fixed so the threshold also lowered on the produce
    path, and the fixture test then correctly merged all six into one
    product. Walking through what that merge implies for
    `current_prices` (keyed by product + store only, no brand dimension)
    surfaced the real issue: two brands sharing one product at the same
    store would fight over a single "current price" slot, and a newer
    scan of either brand would silently hide the other's real, different
    price. Rather than widen `current_prices`' key to fix that, decision 8
    was reversed: produce is scored exactly like every other item now, and
    the `producePath` concept was removed from `shared/matching.ts`
    entirely (`isProduceItem` along with it). The six-blueberry-packer
    test now asserts they stay as six separate products, alongside a new
    test confirming same-brand produce still merges on reworded reports.
  - `narrowCanonicalName` implements the "Buldak Spicy Ramen (Rose)" +
    "...Artificial Spicy Chicken Flavor" → "Buldak Spicy Ramen" example
    from section 8.3 literally: it keeps the existing canonical name's
    *word order and casing*, dropping only the words not shared with the
    newly attached report, rather than trying to reconstruct a phrase
    from an unordered token set.
  - Store resolution (`server/src/services/stores.ts`) implements the
    chain-alias table and chain-level/address-only/geohash cases from
    11a directly, tested against the real messy strings from the export
    (bare chains, bare addresses, `undefined` geocode fragments, HEB/
    H-E-B and Walmart/Walmart Supercenter variants). Geohashing is a
    small from-scratch implementation (`server/src/lib/geohash.ts`,
    checked against the standard Wikipedia worked example) rather than a
    dependency, since it's about 30 lines and the only other option
    pulled in a native module for one function.
  - `current_prices` uses newest-`observedDate`-wins with ties going to
    the latest push, per section 10; it does not yet implement that
    section's "an older trusted report can outrank a newer unverified
    one" refinement, or staleness/confidence, since both depend on trust
    tiers and votes that don't exist until Phase 2.
  - Pull's geo filter is a real bounding-box-then-haversine query, but
    only over stores that already have coordinates; chain-level stores
    (no location) and the "approximate location from the reporter's other
    reports" fallback from section 7 are not implemented, so a bare
    "Kroger" report with no address never reaches a geo-scoped pull yet.
  - Verified with 60 new tests (21 for the matcher against real export
    pairs, 14 for store resolution, 11 for the product service, 9
    route-level for push/pull, 5 for the geohash helper) and a live smoke
    test that is the literal deliverable below: one signed-in account
    pushes a scan, and a second, entirely anonymous device -- never
    signed in, identified only by a device token -- pulls it back by
    location alone.
- Geo proxy (8.6) backed by your Overpass; client switches to it. —
  **done**: `GET /api/geo/nearby-stores` answers from the `stores` table
  when a store is already known within ~75 m, otherwise asks Overpass (if
  `OVERPASS_URL` is set), records each named result through
  `resolveStore` so the same spot never triggers Overpass again and a
  later push resolves to the same store id, and degrades to the table's
  answer if Overpass is down. `/reverse` and `/geocode` wrap Nominatim
  with an identifying User-Agent, a serialized 1.1 s gap per its usage
  policy, and in-memory caches. All three require a session or device
  token. The client (`src/sync/storeLocator.ts`) uses the proxy when
  `VITE_SYNC_API_URL` is set and falls back to the public endpoints on
  any failure, so anonymous users are never broken by an API outage.
  Rate limiting per device is still Phase 2.
- Client: sync settings screen (sign in, home area, sync now, last
  synced), background sync triggers, community cache, search over both
  sets, read-only rendering of community reports with author tier and
  date. — **done**, all under `src/sync/` plus `SyncSettingsScreen.tsx`,
  and hidden entirely unless `VITE_SYNC_API_URL` is set. Notes from
  implementation:
  - `engine.ts` is the whole protocol as pure functions plus one
    orchestrator, `runSync`, that takes the API client, storage, and
    location lookup as parameters; 14 tests cover pending detection,
    push-result folding (tombstone purge, rejected-stays-pending), region
    cursors, pull merging, the 401-signs-out-locally path, and the
    no-location case (push still happens, pull is skipped with a hint).
  - Deleting an already-synced report writes a tombstone (`deletedAt`)
    that is hidden from every screen and purged once the server accepts
    the delete; a never-synced report is just removed.
  - Background sync never triggers the geolocation prompt: it uses the
    device position only when permission is already granted (Permissions
    API), then the newest located own report, then the home area.
  - The server's push now validates each report individually instead of
    the batch as a whole, since one legacy report with an empty store
    (the export has two) would otherwise 400 the other 499.
  - Verified in a real headless browser against a live server
    (Playwright): a device that never signed in pulled phone A's scan by
    location and showed it, with the Community badge, in Add Item search;
    signed in through the settings screen with the emailed code; imported
    a backup and had it pushed by the debounced trigger (stamped with
    `syncedAt`/`productId`/`storeId`, resolved to the same store id as
    phone A's scan); and deleted it, which synced as a tombstone.
- **Deliverable: scan on phone A, see the price on phone B — done end to
  end**, server and client, per the browser run above. What Phase 1 still
  lacks is only what the plan assigns to later phases: votes and trust
  (Phase 2), rate limits (Phase 2), entitlement enforcement (Phase 3), and
  a home-box deployment, which needs your Overpass extract and tunnel
  token.

**Phase 2: trust and moderation** — **done** on this branch.
- Votes (confirm/flag), trust scoring, hide threshold, ingest checks, rate
  limits, admin endpoints + CLI. — **done**: `server/src/services/trust.ts`
  implements the section 9.2 Laplace-smoothed formula and tiers
  (new/restricted/established/trusted), recomputed per-user on every vote
  and on a 6-hour timer (`server/src/index.ts`); `votes.ts` implements
  confirm/flag with one vote per user per report, flag weight equal to the
  flagger's own trust score, and the ≥1.5-combined-weight-from-≥2-flaggers
  hide threshold from 9.3 — a hidden report only ever comes back through
  admin resolution, never by a flagger withdrawing their vote, which a
  test caught by asserting the wrong behavior first and had to be fixed to
  match the plan rather than the other way round. `freshness.ts` adds the
  45-day staleness window and the "a newer unverified report disagreeing
  >15% with a recent (≤30 day) trusted one doesn't override
  `current_prices`" rule from section 10 that Phase 1 deferred.
  `rateLimit.ts` is a self-pruning sliding-window counter table applied to
  new reports (per user and per IP), votes, and the geo proxy. Admin
  (9.5) is both `server/src/routes/admin.ts` (JSON endpoints behind
  `ADMIN_TOKEN`, 503 when unset) and `server/src/admin-cli.ts` (the same
  service functions called directly, for when there's no reason to run a
  server round trip): list/resolve flags, merge products (following merge
  chains), ban/restrict/reactivate a user, force a trust recompute.
  Verified with 122 new tests (177 total) plus a live admin-CLI smoke test
  against a running server database.
- Client: confirm/flag buttons, "unverified" / "unusual price" / "stale"
  badges, current-vs-history price view per product. — **done**:
  `PriceBadges.tsx` renders the three badges on community reports;
  confirm/flag controls live inline in `AddItemScreen`'s search results
  and on each history row in the new `ProductPricesScreen.tsx` (current
  price per store plus full history, reachable via a "View price history"
  link on any community result with a `productId`); `useSync.ts` applies
  a vote's result to both the region cache and in-memory `community`
  state immediately, without waiting for the next pull, via
  `patchSyncedReport`. The "location approximate" badge is not
  implemented -- it depends on the chain-level-store fallback Phase 1 also
  deferred -- and badges only show on community reports, not the user's
  own, since a scan you made yourself has no unverified/outlier/stale
  status to flag. **A real bug surfaced by live verification, not by
  tests:** `AddItemScreen` computed its search results into local state
  once, at search time; confirming or flagging a report updated the sync
  layer correctly but the on-screen button never changed, because it was
  still reading the stale snapshot. Fixed by re-deriving each displayed
  row's volatile fields (vote counts, `myVote`, status) from the live
  `priceData` prop on every render (`liveResults` in
  `src/AddItemScreen.tsx`), which is also why this needed a real browser
  rather than the unit tests -- they mock the sync layer at a level where
  the stale-closure bug is invisible.
- Save-time product match prompt (8.4), which also catches the known
  misses from 11a. — **done**: `GET /api/products/match` (backed by
  `matchCandidates` in `server/src/services/products.ts`) returns the top
  existing product a new scan might be; `PriceScanner.tsx` calls it once
  on entering the details step and `ProductDetails.tsx` shows a "Yes, same
  item / No, different" card, confirming which sets `productId` on the
  saved report so the push handler's `followMerge` uses it directly and
  skips the automatic matcher (`server/src/routes/sync.ts`). Verified by
  typecheck, lint, and the existing unit/route-level tests only, not a
  full browser run -- the scanner's camera capture (`getUserMedia`) is not
  practical to drive from Playwright in this environment.
- Verified end to end in a live browser (Playwright) as a second,
  never-signed-in device: searching pulled-in community reports shows the
  unusual-price badge; confirming while signed out prompts to sign in;
  signing in and confirming shows the updated count immediately; flagging
  replaces the confirm vote and shows "Flagged"; opening price history
  shows the current per-store price and the full history with the same
  badges. The one address-book-style detail worth flagging: flagging a
  report you'd previously confirmed replaces your vote entirely (one vote
  per user, per the data model) rather than adding a second one -- so a
  flag after a confirm correctly drops the confirm count back down.

**Phase 3: cost control and monetization** — **done** on this branch,
except Stripe itself (see below).
- **AI parse proxy.** — **done**: `POST /api/parse` (`server/src/routes/parse.ts`,
  `services/parse.ts`) takes the two photos as base64 data URLs (not
  multipart -- the client already produced data URLs for the canvas
  capture, and matching that existing shape avoided pulling in a
  multipart-form parser for no real benefit), calls OpenRouter with a
  server-side key, and returns just the parsed fields -- the client
  already has the photos it sent, so they don't round-trip back. With no
  `OPENROUTER_API_KEY` configured it returns the same canned response the
  client used to return in Vite dev mode, so a from-scratch checkout still
  works without a real key. `VITE_OPENROUTER_API_KEY` is gone from the
  client bundle; `src/parsePriceImage.ts` now calls the proxy instead of
  OpenRouter directly. Rate limits: `LIMITS.parsePerCallerDay` (50) per
  device token or account (`rateLimit.ts` gained an optional `windowMs`
  param so the existing hourly-window code could serve a daily one too),
  plus a real daily *spend* cap (`PARSE_DAILY_BUDGET_CENTS`) computed from
  OpenRouter's own `usage.total_tokens` at a configurable $/1K-token
  estimate (`parse_spend_daily`, one row per UTC day) -- approximate, not
  real billing data, but closer to an actual spend cap than a second call
  counter would be. Anonymous scanning stays allowed (decision 9), so this
  takes a device token, not just a session. The client now also resizes
  each photo to ≤ 1280 px on the long edge at capture time
  (`PriceScanner.tsx`'s `captureImage`), which shrinks both the upload and
  the copy kept for photo evidence below.
- **Photo evidence.** — **done**: `services/photos.ts` decodes the
  price-tag photo the parse call already received and writes it to
  `PHOTO_DIR/<reportId>.jpg`. The report id is now generated once, up
  front, when a scan starts (`PriceScanner.tsx`'s `reportIdRef`) instead
  of at save time, specifically so the parse call -- which happens before
  the user finishes editing -- can file the photo under the same id the
  report is eventually saved with; a `report_photos` table (no foreign
  key, since the price_reports row may not exist yet, or may never exist
  if the scan is abandoned) tracks which ids have a photo and when.
  `GET /api/reports/:id/photo` is visible to the report's own author
  (session) or an admin (the same shared `ADMIN_TOKEN` as `/api/admin`,
  not a session -- reviewing a flag is an admin action); `admin-cli.ts`
  gained a `photo <reportId> <outFile>` command. Retention (30 days, or
  indefinitely while a report is hidden with an open flag) runs in the
  same periodic maintenance timer as trust recomputation.
- **Entitlement enforcement.** — **done**, still off by default
  (`ENTITLEMENTS_ENFORCED=false`) so seed/dev users keep seeing
  everything. `services/entitlements.ts` implements all of 6.3: the free
  tier (`computeFreeTier`, top 25 by distinct-reporters × distinct-stores
  over 90 days, a 7-day floor once a product enters, everything included
  when a region has fewer than 25 candidates) recomputed periodically
  per-region -- there is no live registry of "regions a pull was ever made
  for", so `computeFreeTierForAllRegions` buckets every distinct store
  location onto the same 0.1°-cell grid the pull cursor uses and
  recomputes each cell at the default 50-mile radius; contributor credits
  (`evaluateContributionCredits`, run on the same timer: verified via a
  distinct confirmation or 14 days active-and-unflagged, non-redundant
  against the pair's current price with a 5% threshold, `established`+
  trust tier only, capped at 10/user/day, revoked via
  `revokeCreditForReport` when admin.ts upholds a flag on the credited
  report); and `entitlementLevel` (subscriber by `users.plan`/
  `planExpiresAt`, contributor by 15+ unrevoked credits in the trailing 30
  days, else public). `GET /api/sync/pull` gates on this only when
  enforced and the caller is public-level: it now returns a real
  `accessLevel` and a `locked` array of `{ canonicalName, storeCount,
  reportCount, newestDate }` summaries (no price) for anything outside the
  region's free set, computed over that pull's own page rather than a
  separate full-history query. `GET /api/me` reports the caller's real
  level and `credits: { earned, needed }` instead of the old
  `enforced: false` placeholder. Client: `AddItemScreen`'s search results
  now render a `LockedResultCard` (report/store counts, a Subscribe
  button) alongside real results; `SyncSettingsScreen` gained a
  Membership section with credits progress and a Subscribe button once
  `entitlement.enforced` is true.
- **Stripe.** — code is done, **not live-verified**: `services/billing.ts`
  talks to Stripe's plain REST API over `fetch` rather than the `stripe`
  SDK (matching this codebase's existing habit of a small typed call over
  a dependency, as with Overpass/Nominatim/OpenRouter), and verifies the
  webhook signature by hand per Stripe's documented HMAC-SHA256 scheme.
  `POST /api/billing/checkout` (session required) creates a subscription
  Checkout Session; `POST /api/billing/webhook` (unauthenticated, verified
  only by signature) applies `checkout.session.completed` and
  `customer.subscription.updated`/`.deleted` to `subscriptions` and
  `users.plan`/`planExpiresAt`. Both 503 when their secret is unset, same
  pattern as `ADMIN_TOKEN`. There is no real Stripe account in this
  environment to test against, so this is reviewed against Stripe's
  documented shapes and covered by unit tests with a faked `fetch` and a
  hand-signed webhook payload, not a live Checkout session or a
  `stripe listen`-forwarded webhook -- do that once before relying on it
  in production, the same caveat Phase 1 left for the Dockerfile.
- **Two real bugs, both found by live browser verification, not by
  tests.** First: `reportRoutes` (`/api/reports/:id/confirm` etc.) applied
  `requireUser` as a blanket `router.use('*', ...)`. `GET
  /api/reports/:id/photo` is mounted at the same `/api/reports` prefix by
  a separate router with its own, different auth (author or admin token,
  not a session) -- but Hono composes middleware across every router
  mounted at a matching path, not just the one that defined a given route,
  so the blanket middleware intercepted photo requests too and 401'd them
  before photos.ts ever ran. Fixed by applying `requireUser` to each of
  reports.ts's three routes individually instead of as a wildcard, which
  is correct regardless of what else later gets mounted at that prefix.
  Second: the locked-summaries feature initially computed `locked` fresh
  on every sync from just that call's pull pages, the way `pushed`/
  `rejected` are -- but unlike `community` (which accumulates in
  `region.reports`, persisted across syncs, and so survives a delta pull
  that returns nothing new), a resync with nothing new since the last
  cursor position returned an empty `locked` array, silently wiping every
  locked teaser the UI had to show. A live Playwright pass caught this
  immediately (search for a locked item worked once, then the entry
  vanished on the next background sync). Fixed by adding `locked` to
  `RegionCache` alongside `reports` and merging it the same way: each
  page's locked summaries upsert into the cached map by product id, and a
  product is only removed once a full report for it actually arrives
  (meaning it entered the free set or the caller's level changed).
- Verified with 64 new server tests (241 total: unit tests for the parse
  proxy's mock/real paths and spend accumulation, photo storage/access/
  retention, Stripe signature verification and event handling, and the
  full entitlements service including free-tier ranking/stickiness and
  contributor-credit eligibility; route tests for `/api/parse`'s rate and
  spend limits, `/api/reports/:id/photo`'s author/admin/stranger access,
  `/api/billing/*`'s 503-when-unconfigured and signed-webhook paths, and
  `/api/sync/pull`'s locked-vs-unlocked gating under enforcement) and 2 new
  client tests for the locked-cache merge/eviction behavior above. The
  entitlements UI (locked teaser, sign-in-gated subscribe button, the
  "not configured" error path, credits progress) was verified end to end
  in a live browser against a server running with
  `ENTITLEMENTS_ENFORCED=true`, which is what surfaced the second bug
  above. The parse proxy and photo evidence were not driven through a
  full browser run -- like Phase 2's save-time match prompt, the
  scanner's `getUserMedia` camera capture isn't practical to automate in
  this environment -- so they're covered by route-level tests only.

**Phase 4: polish and longer-tail**
- Account recovery for a lost mailbox (admin-assisted re-link at first).
- Account data export and deletion endpoints.
- Product merge review page; price history chart on the product view.
- Second cached region; radius slider in settings.

## 15. Decisions

Answered:

1. **Auth**: email required for sync; local use and scanning stay
   account-free. Implemented as email + 6-digit code (6.1), with device
   tokens for anonymous rate limiting (6.2) and entitlement columns from
   day one (6.3).
2. **Hosting**: compared in 13.1. Recommendation is the home box with a
   Cloudflare Tunnel, co-located with your Overpass instance, in a Compose
   stack that can move to a VPS later.
3. **Sync token in the export file**: explained below; recommendation is
   **no**, and with email sign-in there is no longer a reason to.
4. **Pull scope**: geo-scoped from day one, 50-mile default, 100-mile cap
   (section 7).
5. **Flavor variants**: merged under a lower threshold when brand and size
   match exactly; each report keeps its own name (8.3).
6. **Export file**: received and committed as the fixture.
7. **Phase 4 items**: planned. The OpenRouter proxy and photo evidence are
   now Phase 3; account recovery is Phase 4.

**About decision 3, what "token in the export" would have meant.** The sync
token is the credential the app sends with every request; the server treats
whoever presents it as you. Putting it in the backup JSON would have made
the backup work like a saved password: restoring the file on a new phone
would sign that phone in automatically, which is convenient. The cost is
that anyone who gets the file (shared by mistake, left in a downloads folder
on a shared computer, attached to a bug report) could upload price reports
under your name, flag other people's reports as you, and, once sync is paid,
use your subscription. Revoking it would mean signing out everywhere. With
email + code sign-in, a new phone just asks for a code, so the backup file
can stay a plain data file that contains nothing secret. That is what the
plan now assumes; the export format is unchanged apart from the new
per-report fields.

8. **Produce brands**: originally a soft signal so same-size produce from
   different packers would cluster. Reversed after Phase 1 implementation
   showed it breaks `current_prices` (keyed by product + store, no brand
   dimension) -- see section 8.3. Produce is now scored like everything
   else; a brand mismatch rejects the match.
9. **Anonymous AI parsing**: allowed, with per-device daily caps (6.2,
   Phase 3).
10. **Contributors earn access**: yes, only for verified and non-redundant
    reports, with a daily credit cap so spam cannot buy access (6.3.2).
11. **Free tier**: available without sign-in, limited to the top 20–30
    products per region; everything else shows a locked summary and needs
    a subscription or contributor credit (6.3, 6.3.1).

Nothing is open. Implementation starts with Phase 0.
