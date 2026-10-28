import { Hono } from 'hono';
import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import type { AppDb } from '../db/client.js';
import { priceReports, products, stores, users } from '../db/schema.js';
import { requireAuth, type AppEnv } from '../lib/authenticate.js';
import { todayOf } from '../services/freshness.js';
import { ensureFreeTierFresh, entitlementLevel, freeTierProductIds, lockedSummaryFor } from '../services/entitlements.js';
import { toSyncedReport, type ReportRow } from '../services/syncedReport.js';
import type { LockedSummary } from '../../../shared/types.js';

/** How many of the newest reports to look through, and how many locked teasers to return. */
const RECENT_WINDOW = 300;
const MAX_TEASERS = 3;
const DEFAULT_LIMIT = 6;
const MAX_LIMIT = 20;
/** Free sets are looked up per 0.1-degree cell at the default pull radius (see entitlements.ts regionKey). */
const FREE_SET_RADIUS_MI = 50;

/**
 * Home-screen "what people are sharing" sample (plan section 6.3's upsell).
 * Needs no location: it returns the newest reports anywhere, one per product,
 * applying the same free-set rule as a pull -- a public caller gets full
 * reports only for products in the free set of the store's own region, plus a
 * few price-less teasers for the rest, so a visitor always sees that there is
 * something to unlock. One indexed read of the newest rows, instead of the
 * four whole-region pulls the client used to make.
 */
export function discoverRoutes(db: AppDb, entitlementsEnforced = false, now: () => Date = () => new Date()) {
  const router = new Hono<AppEnv>();

  router.get('/', requireAuth(db), (c) => {
    const auth = c.get('auth');
    const limit = Math.min(Math.max(Math.floor(Number(c.req.query('limit') ?? DEFAULT_LIMIT)) || DEFAULT_LIMIT, 1), MAX_LIMIT);

    const caller = auth.kind === 'session' ? db.select().from(users).where(eq(users.id, auth.userId)).all()[0] : undefined;
    const level = caller ? entitlementLevel(caller, now) : 'public';
    const gated = entitlementsEnforced && level === 'public';

    const recent: ReportRow[] = db
      .select({ report: priceReports, store: stores, author: users })
      .from(priceReports)
      .innerJoin(stores, eq(priceReports.storeId, stores.id))
      .innerJoin(users, eq(priceReports.userId, users.id))
      .where(and(eq(priceReports.status, 'active'), isNotNull(priceReports.productId), isNotNull(stores.lat), isNotNull(stores.lon)))
      .orderBy(desc(priceReports.seq))
      .limit(RECENT_WINDOW)
      .all();

    // Newest report per product, plus how many distinct stores each product appears at in this window.
    const newestByProduct = new Map<string, ReportRow>();
    const storesByProduct = new Map<string, Set<string>>();
    for (const row of recent) {
      const productId = row.report.productId!;
      if (!newestByProduct.has(productId)) newestByProduct.set(productId, row);
      const seen = storesByProduct.get(productId) ?? new Set<string>();
      seen.add(row.store.id);
      storesByProduct.set(productId, seen);
    }

    const today = todayOf(now());
    const reports = [];
    const lockedProducts: { productId: string; newestDate: string }[] = [];
    const freeSets = new Map<string, Set<string>>();

    for (const [productId, row] of newestByProduct) {
      if (reports.length >= limit && (!gated || lockedProducts.length >= MAX_TEASERS)) break;

      let isFree = true;
      if (gated) {
        // Same rule as a pull, evaluated in the store's own region.
        const cell = `${row.store.lat!.toFixed(1)},${row.store.lon!.toFixed(1)}`;
        let free = freeSets.get(cell);
        if (!free) {
          ensureFreeTierFresh(db, row.store.lat!, row.store.lon!, FREE_SET_RADIUS_MI, now);
          free = freeTierProductIds(db, row.store.lat!, row.store.lon!, FREE_SET_RADIUS_MI);
          freeSets.set(cell, free);
        }
        isFree = free.has(productId);
      }

      if (isFree) {
        if (reports.length < limit) reports.push(toSyncedReport(row, today));
      } else if (lockedProducts.length < MAX_TEASERS) {
        lockedProducts.push({ productId, newestDate: row.report.observedDate });
      }
    }

    let locked: LockedSummary[] = [];
    if (lockedProducts.length > 0) {
      const found = db.select().from(products).where(inArray(products.id, lockedProducts.map((p) => p.productId))).all();
      locked = lockedProducts.flatMap(({ productId, newestDate }) => {
        const product = found.find((p) => p.id === productId);
        return product ? [lockedSummaryFor(product, storesByProduct.get(productId)?.size ?? 1, newestDate)] : [];
      });
    }

    return c.json({ accessLevel: entitlementsEnforced ? level : 'unrestricted', reports, locked });
  });

  return router;
}
