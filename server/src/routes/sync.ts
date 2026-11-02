import { Hono } from 'hono';
import { z } from 'zod';
import { and, asc, eq, gt, gte, inArray, lte, ne } from 'drizzle-orm';
import type { AppDb } from '../db/client.js';
import { priceReports, reportVotes, stores, users } from '../db/schema.js';
import { haversineMiles } from '../lib/geohash.js';
import { clientIp } from '../lib/clientIp.js';
import { requireAuth, requireUser, type AppEnv } from '../lib/authenticate.js';
import { resolveStore } from '../services/stores.js';
import { followMerge, refreshProductFromReports, resolveProduct } from '../services/products.js';
import { refreshCurrentPrice, todayOf } from '../services/freshness.js';
import { consumeRateLimit, LIMITS } from '../services/rateLimit.js';
import { toSyncedReport } from '../services/syncedReport.js';
import { ensureFreeTierFresh, entitlementLevel, freeSetFingerprint, freeTierProductIds, lockedSummaryFor } from '../services/entitlements.js';
import { parsePrice } from '../../../shared/price.js';
import type { LockedSummary, PriceReportUpsert, PriceReportPushResult, SyncedPriceReport } from '../../../shared/types.js';
import { products } from '../db/schema.js';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
/** Section 9.4: a price above this is rejected outright. */
const MAX_PRICE_CENTS = 10_000 * 100;
/** Section 9.4: outside this multiple of the product's median (with >= 3 reports) earns the "unusual price" hint. */
const OUTLIER_LOW = 0.25;
const OUTLIER_HIGH = 4;
const OUTLIER_MIN_REPORTS = 3;

const reportSchema = z.object({
  id: z.string().min(1),
  itemName: z.string().trim().min(1).max(300),
  brand: z.string().trim().max(120).default(''),
  tags: z.array(z.string()).default([]),
  quantity: z.number().positive().nullable().default(null),
  quantityUnits: z.string().nullable().default(null),
  price: z.union([z.string(), z.number()]).transform(String),
  store: z.string().trim().min(1).max(300),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  observedDate: z.string().regex(DATE_ONLY),
  expiresAt: z.string().regex(DATE_ONLY).nullable().optional(),
  isSale: z.boolean().optional().default(false),
  updatedAt: z.string().min(1),
  deletedAt: z.string().nullable().optional(),
  productId: z.string().nullable().optional(),
});

/** The batch is validated per report, not as a whole: one malformed legacy report must not block the other 499. */
const pushSchema = z.object({ reports: z.array(z.unknown()).max(500) });

interface PushContext {
  user: typeof users.$inferSelect;
  ip: string;
  now: () => Date;
}

function pushOneReport(db: AppDb, ctx: PushContext, input: PriceReportUpsert): PriceReportPushResult {
  const userId = ctx.user.id;
  const existing = db.select().from(priceReports).where(eq(priceReports.id, input.id)).all()[0];
  if (existing && existing.userId !== userId) {
    return { id: input.id, status: 'rejected', error: 'This report belongs to a different author.' };
  }
  // Last-writer-wins for the author's own report (multi-device case, plan section 7).
  if (existing && Date.parse(existing.updatedAt) >= Date.parse(input.updatedAt)) {
    return {
      id: input.id,
      status: existing.status,
      productId: existing.productId ?? undefined,
      storeId: existing.storeId ?? undefined,
      seq: existing.seq,
      reviewReason: existing.reviewReason,
    };
  }

  if (input.deletedAt) {
    if (!existing) return { id: input.id, status: 'deleted' };
    db.update(priceReports)
      .set({ status: 'deleted', deletedAt: input.deletedAt, updatedAt: input.updatedAt })
      .where(eq(priceReports.id, input.id))
      .run();
    if (existing.productId) refreshProductFromReports(db, existing.productId);
    if (existing.productId && existing.storeId) refreshCurrentPrice(db, existing.productId, existing.storeId, ctx.now);
    return { id: input.id, status: 'deleted', productId: existing.productId ?? undefined, storeId: existing.storeId ?? undefined, seq: existing.seq };
  }

  const parsedPrice = parsePrice(input.price);
  if (!parsedPrice) return { id: input.id, status: 'rejected', error: `Could not parse price "${input.price}".` };
  if (parsedPrice.cents > MAX_PRICE_CENTS) {
    return { id: input.id, status: 'rejected', error: 'Price is above the $10,000 sanity limit.' };
  }

  // Rate limits apply to new reports only; edits and re-pushes of the same id are free.
  if (!existing) {
    if (!consumeRateLimit(db, `push:user:${userId}`, LIMITS.reportsPerUserHour, ctx.now)) {
      return { id: input.id, status: 'rejected', error: 'Too many new reports in the last hour. Try again later.' };
    }
    if (!consumeRateLimit(db, `push:ip:${ctx.ip}`, LIMITS.reportsPerIpHour, ctx.now)) {
      return { id: input.id, status: 'rejected', error: 'Too many new reports from this network in the last hour. Try again later.' };
    }
  }

  const store = resolveStore(db, { rawStore: input.store, lat: input.latitude, lon: input.longitude });
  const matchable = {
    itemName: input.itemName,
    brand: input.brand,
    tags: input.tags,
    quantity: input.quantity,
    quantityUnits: input.quantityUnits,
  };
  // A product the user confirmed at save time (section 8.4) wins over the matcher.
  const confirmedProductId = input.productId ? followMerge(db, input.productId) : null;
  const productId = confirmedProductId ?? resolveProduct(db, matchable, parsedPrice.cents).productId;

  // Outlier hint uses the product's stats before this report is counted (section 9.4). Never a rejection.
  const product = db.select().from(products).where(eq(products.id, productId)).all()[0];
  const isOutlier =
    !!product &&
    product.reportCount >= OUTLIER_MIN_REPORTS &&
    !!product.medianPriceCents &&
    (parsedPrice.cents < OUTLIER_LOW * product.medianPriceCents || parsedPrice.cents > OUTLIER_HIGH * product.medianPriceCents);
  const priceReview = isOutlier || parsedPrice.likelyMissingDecimalCents ? 'price_outlier' : null;

  // Restricted authors' new reports wait for two confirmations or an admin (section 9.4).
  const heldForReview = ctx.user.status === 'restricted';
  const keepsHidden = existing?.status === 'hidden' && (existing.reviewReason === 'flagged' || existing.reviewReason === 'banned');
  const status = keepsHidden || heldForReview ? 'hidden' : 'active';
  const reviewReason = keepsHidden ? existing!.reviewReason : heldForReview ? 'new_user' : priceReview;

  const values = {
    productId,
    storeId: store.id,
    itemName: input.itemName,
    brand: input.brand,
    tags: JSON.stringify(input.tags),
    quantity: input.quantity,
    quantityUnits: input.quantityUnits,
    priceCents: parsedPrice.cents,
    priceRaw: String(input.price),
    observedDate: input.observedDate,
    expiresAt: input.expiresAt ?? null,
    isSale: input.isSale ?? false,
    freshnessDate: input.observedDate,
    status,
    reviewReason,
    updatedAt: input.updatedAt,
  } as const;

  // Duplicate collapse (section 9.4): a second scan of the same shelf tag the same day updates the first.
  const duplicate = existing
    ? null
    : db
        .select()
        .from(priceReports)
        .where(
          and(
            eq(priceReports.userId, userId),
            eq(priceReports.productId, productId),
            eq(priceReports.storeId, store.id),
            eq(priceReports.observedDate, input.observedDate),
            ne(priceReports.status, 'deleted'),
          ),
        )
        .all()[0];

  const target = existing ?? duplicate ?? null;
  if (target) {
    db.update(priceReports).set(values).where(eq(priceReports.id, target.id)).run();
    if (target.productId && target.productId !== productId) refreshProductFromReports(db, target.productId);
    if (target.productId && target.storeId && (target.productId !== productId || target.storeId !== store.id)) {
      refreshCurrentPrice(db, target.productId, target.storeId, ctx.now);
    }
  } else {
    db.insert(priceReports).values({ id: input.id, userId, source: 'scan', ...values }).run();
    db.update(users).set({ reportsCount: ctx.user.reportsCount + 1 }).where(eq(users.id, userId)).run();
    ctx.user = { ...ctx.user, reportsCount: ctx.user.reportsCount + 1 };
  }

  refreshProductFromReports(db, productId);
  refreshCurrentPrice(db, productId, store.id, ctx.now);

  const savedId = target?.id ?? input.id;
  const saved = db.select().from(priceReports).where(eq(priceReports.id, savedId)).all()[0]!;
  return {
    id: input.id,
    status: saved.status,
    productId,
    storeId: store.id,
    seq: saved.seq,
    reviewReason: saved.reviewReason,
    ...(duplicate ? { collapsedInto: duplicate.id } : {}),
    normalized: { itemName: product?.canonicalName ?? input.itemName, brand: input.brand, priceCents: parsedPrice.cents },
  };
}

type PullRow = { report: typeof priceReports.$inferSelect; store: typeof stores.$inferSelect; author: typeof users.$inferSelect };

export function syncRoutes(db: AppDb, now: () => Date = () => new Date(), entitlementsEnforced = false) {
  const router = new Hono<AppEnv>();

  router.post('/push', requireUser(db), async (c) => {
    const auth = c.get('auth');
    if (auth.kind !== 'session') return c.json({ error: 'Sign-in required' }, 401);
    const user = db.select().from(users).where(eq(users.id, auth.userId)).all()[0];
    if (!user) return c.json({ error: 'Sign-in required' }, 401);
    if (user.status === 'banned') return c.json({ error: 'This account cannot share prices.' }, 403);

    const body = await c.req.json().catch(() => null);
    const parsed = pushSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request.' }, 400);

    const ctx: PushContext = { user, ip: clientIp(c), now };
    const results = parsed.data.reports.map((raw): PriceReportPushResult => {
      const report = reportSchema.safeParse(raw);
      if (!report.success) {
        const id = typeof raw === 'object' && raw !== null && typeof (raw as { id?: unknown }).id === 'string' ? (raw as { id: string }).id : '';
        const issue = report.error.issues[0];
        return { id, status: 'rejected', error: `${issue?.path.join('.') || 'report'}: ${issue?.message ?? 'invalid'}` };
      }
      return pushOneReport(db, ctx, report.data);
    });
    return c.json({ results });
  });

  router.get('/pull', requireAuth(db), (c) => {
    const auth = c.get('auth');
    const since = Number(c.req.query('since') ?? '0');
    const lat = Number(c.req.query('lat'));
    const lon = Number(c.req.query('lon'));
    const radiusMi = Math.min(Number(c.req.query('radiusMi') ?? '50') || 50, 100);
    const limit = Math.min(Number(c.req.query('limit') ?? '500') || 500, 500);

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return c.json({ error: 'lat and lon are required.' }, 400);
    }

    // Bounding-box prequery (indexed) followed by an exact haversine check
    // (plan section 7) -- fine at this scale, no spatial extension needed.
    const latDelta = radiusMi / 69; // ~69 miles per degree of latitude
    const lonDelta = radiusMi / (69 * Math.max(Math.cos((lat * Math.PI) / 180), 0.01));

    // Read in seq order, a chunk at a time, and stop as soon as a page is
    // full: a client's first pull of a busy region must not load every report
    // in it just to keep the first `limit`. The bounding box is in SQL (it
    // also drops stores with no coordinates -- chain-level stores are excluded
    // from geo-scoped pulls for now, see plan section 8.5/11a); the exact
    // circle is checked here, which is why a chunk can yield fewer rows than it holds.
    const PULL_CHUNK = 1000;
    const page: PullRow[] = [];
    let cursor = Number.isFinite(since) ? since : 0;
    while (page.length < limit) {
      const chunk = db
        .select({ report: priceReports, store: stores, author: users })
        .from(priceReports)
        .innerJoin(stores, eq(priceReports.storeId, stores.id))
        .innerJoin(users, eq(priceReports.userId, users.id))
        .where(
          and(
            gt(priceReports.seq, cursor),
            gte(stores.lat, lat - latDelta),
            lte(stores.lat, lat + latDelta),
            gte(stores.lon, lon - lonDelta),
            lte(stores.lon, lon + lonDelta),
          ),
        )
        .orderBy(asc(priceReports.seq))
        .limit(PULL_CHUNK)
        .all();
      for (const row of chunk) {
        if (row.store.lat == null || row.store.lon == null) continue;
        if (haversineMiles(lat, lon, row.store.lat, row.store.lon) > radiusMi) continue;
        page.push(row);
        if (page.length === limit) break;
      }
      if (chunk.length < PULL_CHUNK) break;
      cursor = chunk[chunk.length - 1].report.seq;
    }
    const nextSince = page.length > 0 ? page[page.length - 1].report.seq : since;

    const myVotes = new Map<string, 'confirm' | 'flag'>();
    if (auth.kind === 'session' && page.length > 0) {
      const ids = page.map((p) => p.report.id);
      for (const v of db
        .select({ reportId: reportVotes.reportId, kind: reportVotes.kind })
        .from(reportVotes)
        .where(and(eq(reportVotes.userId, auth.userId), inArray(reportVotes.reportId, ids)))
        .all()) {
        myVotes.set(v.reportId, v.kind);
      }
    }

    const today = todayOf(now());
    const toWire = (row: PullRow) => toSyncedReport(row, today, myVotes.get(row.report.id) ?? null);

    // Section 6.3: a public-level caller (no account, or signed in without
    // a subscription or enough contributor credit) sees a locked summary
    // instead of the price for anything outside the region's free set.
    // Locked/free are always computed over this page's rows -- an
    // approximation of "nearby" scoped to what this pull actually
    // returned, not a separate full-history query.
    const level = auth.kind === 'session'
      ? (() => {
          const caller = db.select().from(users).where(eq(users.id, auth.userId)).all()[0];
          return caller ? entitlementLevel(caller, now) : 'public';
        })()
      : 'public';
    const accessLevel = entitlementsEnforced ? level : 'unrestricted';

    let reports: SyncedPriceReport[];
    let locked: LockedSummary[];
    let freeSet: string | null = null;
    if (entitlementsEnforced && level === 'public') {
      ensureFreeTierFresh(db, lat, lon, radiusMi, now);
      freeSet = freeSetFingerprint(db, lat, lon, radiusMi);
      const freeIds = freeTierProductIds(db, lat, lon, radiusMi);
      const isLocked = (row: (typeof page)[number]) => !!row.report.productId && !freeIds.has(row.report.productId);
      reports = page.filter((row) => !isLocked(row)).map(toWire);

      const byProduct = new Map<string, { storeIds: Set<string>; newestDate: string }>();
      for (const row of page.filter(isLocked)) {
        const productId = row.report.productId!;
        const entry = byProduct.get(productId) ?? { storeIds: new Set<string>(), newestDate: '' };
        entry.storeIds.add(row.store.id);
        if (row.report.observedDate > entry.newestDate) entry.newestDate = row.report.observedDate;
        byProduct.set(productId, entry);
      }
      locked = [...byProduct.entries()]
        .map(([productId, { storeIds, newestDate }]) => {
          const product = db.select().from(products).where(eq(products.id, productId)).all()[0];
          return product ? lockedSummaryFor(product, storeIds.size, newestDate) : null;
        })
        .filter((s): s is LockedSummary => s !== null);
    } else {
      reports = page.map(toWire);
      locked = [];
    }

    return c.json({ accessLevel, reports, locked, nextSince, freeSet });
  });

  return router;
}
