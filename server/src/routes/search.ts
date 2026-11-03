import { Hono } from 'hono';
import { and, desc, eq, inArray, isNotNull, like, sql } from 'drizzle-orm';
import type { AppDb } from '../db/client.js';
import { priceReports, products, reportVotes, stores, users } from '../db/schema.js';
import { requireAuth, type AppEnv } from '../lib/authenticate.js';
import { haversineMiles } from '../lib/geohash.js';
import { todayOf } from '../services/freshness.js';
import { entitlementLevel, ensureFreeTierFresh, freeAnywhereProductIds, lockedSummaryFor, recordSearches } from '../services/entitlements.js';
import { consumeRateLimit, LIMITS } from '../services/rateLimit.js';
import { toSyncedReport, type ReportRow } from '../services/syncedReport.js';
import { matchesQuery, queryTokens } from '../../../shared/search.js';
import type { LockedSummary, SearchResponseBody } from '../../../shared/types.js';

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;
const DEFAULT_RADIUS_MI = 50;
const MAX_RADIUS_MI = 100;
/** The SQL prefilter only needs a superset of what matchesQuery accepts; the exact test runs in JS afterwards. */
const PREFILTER_CHARS = 3;

/**
 * Server-side item search. Returns every active report whose name, brand or
 * tags match the query (same matcher as the client's offline search), newest
 * per product and store, optionally limited to a radius around the caller. A
 * free caller gets full reports for products in the free set and price-less
 * teasers for the rest, so they always see how much more there is to unlock.
 * Each search also counts toward the matched products' "most searched" rank,
 * which decides the free set (see entitlements.ts).
 */
export function searchRoutes(db: AppDb, entitlementsEnforced = false, now: () => Date = () => new Date()) {
  const router = new Hono<AppEnv>();

  router.get('/', requireAuth(db), (c) => {
    const auth = c.get('auth');
    const q = (c.req.query('q') ?? '').trim().slice(0, 200);
    const tokens = queryTokens(q);
    if (tokens.length === 0) return c.json({ error: 'q is required.' }, 400);

    const latRaw = c.req.query('lat');
    const lonRaw = c.req.query('lon');
    const lat = latRaw === undefined ? NaN : Number(latRaw);
    const lon = lonRaw === undefined ? NaN : Number(lonRaw);
    const location = Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
    const radiusMi = Math.min(Math.max(Number(c.req.query('radiusMi') ?? DEFAULT_RADIUS_MI) || DEFAULT_RADIUS_MI, 1), MAX_RADIUS_MI);
    const limit = Math.min(Math.max(Math.floor(Number(c.req.query('limit') ?? DEFAULT_LIMIT)) || DEFAULT_LIMIT, 1), MAX_LIMIT);

    const caller = auth.kind === 'session' ? db.select().from(users).where(eq(users.id, auth.userId)).all()[0] : undefined;
    const level = caller ? entitlementLevel(caller, now) : 'public';
    const gated = entitlementsEnforced && level === 'public';

    // Query tokens are lowercase letters and digits only (see tokenize), so they are safe in a LIKE pattern.
    // Every query token must appear (at least its leading characters) somewhere in the report's text.
    const text = sql`lower(${priceReports.itemName} || ' ' || ${priceReports.brand} || ' ' || ${priceReports.tags})`;
    const prefilter = tokens.map((t) => like(text, `%${t.slice(0, PREFILTER_CHARS)}%`));
    const conditions = [eq(priceReports.status, 'active'), isNotNull(priceReports.productId), ...prefilter];
    if (location) {
      const latDelta = radiusMi / 69;
      const lonDelta = radiusMi / (69 * Math.max(Math.cos((location.lat * Math.PI) / 180), 0.01));
      conditions.push(
        sql`${stores.lat} between ${location.lat - latDelta} and ${location.lat + latDelta}`,
        sql`${stores.lon} between ${location.lon - lonDelta} and ${location.lon + lonDelta}`,
      );
    }

    const rows: ReportRow[] = db
      .select({ report: priceReports, store: stores, author: users })
      .from(priceReports)
      .innerJoin(stores, eq(priceReports.storeId, stores.id))
      .innerJoin(users, eq(priceReports.userId, users.id))
      .where(and(...conditions))
      .orderBy(desc(priceReports.seq))
      .all();

    // Exact match, inside the radius, newest report per (product, store).
    const newest = new Map<string, ReportRow>();
    const storesByProduct = new Map<string, Set<string>>();
    for (const row of rows) {
      if (!matchesQuery({ itemName: row.report.itemName, brand: row.report.brand, tags: JSON.parse(row.report.tags) as string[] }, q)) continue;
      if (location && (row.store.lat == null || row.store.lon == null || haversineMiles(location.lat, location.lon, row.store.lat, row.store.lon) > radiusMi)) continue;
      const productId = row.report.productId!;
      const key = `${productId}|${row.store.id}`;
      if (newest.has(key)) continue;
      newest.set(key, row);
      const seen = storesByProduct.get(productId) ?? new Set<string>();
      seen.add(row.store.id);
      storesByProduct.set(productId, seen);
    }

    // A brand-new region's products should unlock promptly rather than wait for the periodic job.
    if (gated && location) ensureFreeTierFresh(db, Number(location.lat.toFixed(1)), Number(location.lon.toFixed(1)), DEFAULT_RADIUS_MI, now);
    const free = gated ? freeAnywhereProductIds(db) : null;

    const myVotes = new Map<string, 'confirm' | 'flag'>();
    const freeRows: ReportRow[] = [];
    const lockedByProduct = new Map<string, string>(); // productId -> newest observed date
    for (const row of newest.values()) {
      const productId = row.report.productId!;
      if (free && !free.has(productId)) {
        if (row.report.observedDate > (lockedByProduct.get(productId) ?? '')) lockedByProduct.set(productId, row.report.observedDate);
      } else {
        freeRows.push(row);
      }
    }
    const truncated = freeRows.length > limit;
    const page = freeRows.slice(0, limit);

    if (auth.kind === 'session' && page.length > 0) {
      for (const v of db
        .select({ reportId: reportVotes.reportId, kind: reportVotes.kind })
        .from(reportVotes)
        .where(and(eq(reportVotes.userId, auth.userId), inArray(reportVotes.reportId, page.map((r) => r.report.id))))
        .all()) {
        myVotes.set(v.reportId, v.kind);
      }
    }
    const today = todayOf(now());
    const reports = page.map((row) => toSyncedReport(row, today, myVotes.get(row.report.id) ?? null));

    let locked: LockedSummary[] = [];
    if (lockedByProduct.size > 0) {
      const found = db.select().from(products).where(inArray(products.id, [...lockedByProduct.keys()])).all();
      locked = found.map((p) => lockedSummaryFor(p, storesByProduct.get(p.id)?.size ?? 1, lockedByProduct.get(p.id)!));
    }

    // Count the search toward every matched product (locked ones too, so they can earn a place in the free set).
    const bucket = auth.kind === 'session' ? `search:user:${auth.userId}` : `search:device:${auth.deviceId}`;
    if (storesByProduct.size > 0 && consumeRateLimit(db, bucket, LIMITS.searchCountedPerCallerHour, now)) {
      recordSearches(db, storesByProduct.keys(), location, now);
    }

    const body: SearchResponseBody = { accessLevel: entitlementsEnforced ? level : 'unrestricted', reports, locked, truncated };
    return c.json(body);
  });

  return router;
}
