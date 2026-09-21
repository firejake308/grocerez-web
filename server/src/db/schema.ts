import { sql } from 'drizzle-orm';
import {
  sqliteTable,
  text,
  integer,
  real,
  primaryKey,
  uniqueIndex,
  index,
  type AnySQLiteColumn,
} from 'drizzle-orm/sqlite-core';

/**
 * Server data model. Mirrors docs/server-sync-plan.md sections 5 and 6.
 * IDs are text UUIDs (client-generated for price_reports, server-generated
 * with crypto.randomUUID() everywhere else). Timestamps are ISO-8601 text.
 * Money is integer cents.
 */

// --- Users, auth, devices, billing (section 6) --------------------------

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull(),
  createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  displayName: text('display_name'),

  trustScore: real('trust_score').notNull().default(0.5),
  status: text('status', { enum: ['active', 'restricted', 'banned'] }).notNull().default('active'),
  reportsCount: integer('reports_count').notNull().default(0),
  confirmedCount: integer('confirmed_count').notNull().default(0),
  upheldFlagsCount: integer('upheld_flags_count').notNull().default(0),
  /** Flags this user raised that an admin dismissed; every three count as one "bad" report in the trust score (section 9.3). */
  dismissedFlagsCount: integer('dismissed_flags_count').notNull().default(0),

  // Entitlements (section 6.3). Enforcement is gated by ENTITLEMENTS_ENFORCED
  // and lands in Phase 3; the columns exist now so nothing migrates later.
  plan: text('plan', { enum: ['free', 'paid'] }).notNull().default('free'),
  planExpiresAt: text('plan_expires_at'),
  homeLat: real('home_lat'),
  homeLon: real('home_lon'),
}, (t) => ([
  uniqueIndex('users_email_unique').on(t.email),
]));

export const authCodes = sqliteTable('auth_codes', {
  id: text('id').primaryKey(),
  email: text('email').notNull(),
  codeHash: text('code_hash').notNull(),
  createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  expiresAt: text('expires_at').notNull(),
  attempts: integer('attempts').notNull().default(0),
  consumedAt: text('consumed_at'),
}, (t) => ([
  index('auth_codes_email_idx').on(t.email),
]));

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  tokenHash: text('token_hash').notNull(),
  createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  lastSeenAt: text('last_seen_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  expiresAt: text('expires_at').notNull(),
}, (t) => ([
  uniqueIndex('sessions_token_hash_unique').on(t.tokenHash),
  index('sessions_user_idx').on(t.userId),
]));

/** Anonymous device identity (section 6.2): free-tier pulls and rate limits without an account. */
export const devices = sqliteTable('devices', {
  id: text('id').primaryKey(),
  tokenHash: text('token_hash').notNull(),
  userId: text('user_id').references(() => users.id),
  createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  lastSeenAt: text('last_seen_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
}, (t) => ([
  uniqueIndex('devices_token_hash_unique').on(t.tokenHash),
]));

export const subscriptions = sqliteTable('subscriptions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  provider: text('provider').notNull().default('stripe'),
  providerRef: text('provider_ref').notNull(),
  status: text('status').notNull(),
  currentPeriodEnd: text('current_period_end'),
}, (t) => ([
  index('subscriptions_user_idx').on(t.userId),
]));

// --- Stores (section 5, refined in 11a / 8.5) ----------------------------

export const stores = sqliteTable('stores', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  address: text('address'),
  lat: real('lat'),
  lon: real('lon'),
  geohash7: text('geohash7'),
  /** Normalized, aliased chain name (e.g. "h-e-b" for both "HEB" and "H-E-B"). */
  chainKey: text('chain_key').notNull(),
  /** True when this store has no known location -- a bare chain name like "Walmart". */
  isChainLevel: integer('is_chain_level', { mode: 'boolean' }).notNull().default(false),
  /** Dedup key: chainKey + geohash7, or chainKey + normalized address, or chainKey alone. */
  storeKey: text('store_key').notNull(),
}, (t) => ([
  uniqueIndex('stores_store_key_unique').on(t.storeKey),
  index('stores_chain_key_idx').on(t.chainKey),
  index('stores_lat_lon_idx').on(t.lat, t.lon),
]));

// --- Products and matching (section 8) -----------------------------------

export const products = sqliteTable('products', {
  id: text('id').primaryKey(),
  canonicalName: text('canonical_name').notNull(),
  brandKey: text('brand_key').notNull().default(''),
  sizeFamily: text('size_family', { enum: ['weight', 'volume', 'count', 'unknown'] }).notNull().default('unknown'),
  sizeBaseQty: real('size_base_qty'),
  sizeLabel: text('size_label'),
  /** JSON string array. */
  tags: text('tags').notNull().default('[]'),
  reportCount: integer('report_count').notNull().default(0),
  medianPriceCents: integer('median_price_cents'),
  /** Manual merge target; readers follow the chain. Null when not merged. */
  mergedInto: text('merged_into').references((): AnySQLiteColumn => products.id),
  /** Matcher grey-zone hint for admin review (section 8.3). */
  possibleDuplicateOf: text('possible_duplicate_of').references((): AnySQLiteColumn => products.id),
  createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
}, (t) => ([
  index('products_brand_key_idx').on(t.brandKey),
  index('products_size_family_idx').on(t.sizeFamily),
]));

/** Inverted index for candidate lookup (section 8.2). One row per (product, name token). */
export const productTokens = sqliteTable('product_tokens', {
  productId: text('product_id').notNull().references(() => products.id),
  token: text('token').notNull(),
}, (t) => ([
  primaryKey({ columns: [t.productId, t.token] }),
  index('product_tokens_token_idx').on(t.token),
]));

// --- Price reports, votes, and the read model (sections 7, 9, 10) --------

export const priceReports = sqliteTable('price_reports', {
  /** Server-assigned monotonic sync cursor; the real primary key (sqlite rowid). */
  seq: integer('seq').primaryKey({ autoIncrement: true }),
  /** Client-generated UUID; pushed as-is so push is idempotent. Unique, not the PK. */
  id: text('id').notNull(),
  userId: text('user_id').notNull().references(() => users.id),
  productId: text('product_id').references(() => products.id),
  storeId: text('store_id').references(() => stores.id),

  itemName: text('item_name').notNull(),
  brand: text('brand').notNull().default(''),
  /** JSON string array. */
  tags: text('tags').notNull().default('[]'),
  quantity: real('quantity'),
  quantityUnits: text('quantity_units'),
  priceCents: integer('price_cents').notNull(),
  priceRaw: text('price_raw').notNull(),

  observedDate: text('observed_date').notNull(),
  expiresAt: text('expires_at'),
  isSale: integer('is_sale', { mode: 'boolean' }).notNull().default(false),
  /** Staleness reference (section 10): observed_date, bumped to the date of each confirmation. */
  freshnessDate: text('freshness_date').notNull().default(''),

  source: text('source', { enum: ['scan', 'manual', 'import'] }).notNull().default('scan'),
  status: text('status', { enum: ['active', 'hidden', 'deleted'] }).notNull().default('active'),
  reviewReason: text('review_reason', { enum: ['price_outlier', 'flagged', 'new_user', 'banned'] }),

  confirmCount: integer('confirm_count').notNull().default(0),
  flagWeight: real('flag_weight').notNull().default(0),

  createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
}, (t) => ([
  uniqueIndex('price_reports_id_unique').on(t.id),
  index('price_reports_user_idx').on(t.userId),
  index('price_reports_product_store_idx').on(t.productId, t.storeId),
]));

export const reportVotes = sqliteTable('report_votes', {
  id: text('id').primaryKey(),
  reportId: text('report_id').notNull().references(() => priceReports.id),
  userId: text('user_id').notNull().references(() => users.id),
  kind: text('kind', { enum: ['confirm', 'flag'] }).notNull(),
  reason: text('reason', { enum: ['wrong_price', 'wrong_item', 'expired', 'duplicate', 'spam', 'other'] }),
  note: text('note'),
  /** Flags only: the voter's trust score at the time, so a fresh account's flag counts less (section 9.3). */
  weight: real('weight').notNull().default(0),
  createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  resolution: text('resolution', { enum: ['upheld', 'dismissed'] }),
  resolvedAt: text('resolved_at'),
}, (t) => ([
  uniqueIndex('report_votes_report_user_unique').on(t.reportId, t.userId),
]));

/** Current price per (product, store); maintained on write, not computed at read time. */
export const currentPrices = sqliteTable('current_prices', {
  productId: text('product_id').notNull().references(() => products.id),
  storeId: text('store_id').notNull().references(() => stores.id),
  reportId: text('report_id').notNull().references(() => priceReports.id),
  priceCents: integer('price_cents').notNull(),
  observedDate: text('observed_date').notNull(),
  expiresAt: text('expires_at'),
  /** The author's trust score; the client dims low-confidence prices. */
  confidence: real('confidence').notNull().default(1),
  isStale: integer('is_stale', { mode: 'boolean' }).notNull().default(false),
  /**
   * Section 10's override: when a newer report from an unverified author
   * disagrees with a recent trusted one, the trusted report is current and
   * the newer one is kept here so the client can show "reported $X on
   * <date> (unverified)".
   */
  contestedReportId: text('contested_report_id').references(() => priceReports.id),
}, (t) => ([
  primaryKey({ columns: [t.productId, t.storeId] }),
]));

/** Sliding-window rate limiting (section 9.4). One row per counted event; rows older than the window are pruned on check. */
export const rateLimitEvents = sqliteTable('rate_limit_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  bucket: text('bucket').notNull(),
  createdAt: text('created_at').notNull(),
}, (t) => ([
  index('rate_limit_events_bucket_idx').on(t.bucket, t.createdAt),
]));

/** Phase 3 AI parse proxy's daily spend cap: one row per UTC day, running total. Not real billing data -- a token-count estimate (section 9.4/Phase 3). */
export const parseSpendDaily = sqliteTable('parse_spend_daily', {
  day: text('day').primaryKey(),
  costCents: real('cost_cents').notNull().default(0),
});

/**
 * Photo evidence (Phase 3): tracks which report ids have a stored price-tag
 * photo on disk (under PHOTO_DIR) and when, for retention and access
 * checks. No FK to price_reports -- the photo is saved at parse time,
 * before the report (or its final id) necessarily exists as a pushed row.
 */
export const reportPhotos = sqliteTable('report_photos', {
  reportId: text('report_id').primaryKey(),
  createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
});

// --- Entitlements: free tier and contributor credits (section 6.3) -------

export const freeTierProducts = sqliteTable('free_tier_products', {
  regionKey: text('region_key').notNull(),
  productId: text('product_id').notNull().references(() => products.id),
  rank: integer('rank').notNull(),
  enteredAt: text('entered_at').notNull(),
  computedAt: text('computed_at').notNull(),
}, (t) => ([
  primaryKey({ columns: [t.regionKey, t.productId] }),
]));

export const contributionCredits = sqliteTable('contribution_credits', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  reportId: text('report_id').notNull().references(() => priceReports.id),
  earnedAt: text('earned_at').notNull(),
  revokedAt: text('revoked_at'),
}, (t) => ([
  index('contribution_credits_user_idx').on(t.userId),
  uniqueIndex('contribution_credits_report_unique').on(t.reportId),
]));
