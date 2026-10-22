import { createHash } from 'node:crypto';
import { and, asc, eq, gte, isNull } from 'drizzle-orm';
import type { AppDb } from '../db/client.js';
import { contributionCredits, creditRedemptions, currentPrices, freeTierProducts, priceReports, products, stores, users } from '../db/schema.js';
import { haversineMiles } from '../lib/geohash.js';
import { newId } from '../lib/ids.js';
import type { LockedSummary } from '../../../shared/types.js';
import { isUnverifiedTier, tierForUser } from './trust.js';

/**
 * Public free tier plus a paid subscription (plan section 6.3). Gated
 * behind ENTITLEMENTS_ENFORCED, off by default so seed/dev users keep
 * seeing everything until Stripe is actually configured.
 */

export const FREE_TIER_PRODUCT_COUNT = 25;
const FREE_TIER_STICKY_DAYS = 7;
const FREE_TIER_WINDOW_DAYS = 90;

export const CREDIT_DAILY_CAP = 10;
/** Each verified, non-redundant report is worth this many credits (section 6.3.2). */
export const CREDITS_PER_VERIFIED_REPORT = 10;
/** Redeeming this many credits buys one free month of access. */
export const CREDITS_PER_FREE_MONTH = 200;
export const FREE_MONTH_DAYS = 30;
/** Credits older than this stop counting toward the balance. */
export const CREDIT_EXPIRY_DAYS = 90;
/** Paid access outlives `planExpiresAt` by this long, so a delayed renewal webhook doesn't lock out a paying user. */
const SUBSCRIPTION_GRACE_DAYS = 3;
const CREDIT_VERIFY_DAYS = 14;
const CREDIT_NONREDUNDANT_DAYS = 30;
const CREDIT_PRICE_DELTA = 0.05;

export type EntitlementLevel = 'public' | 'contributor' | 'subscriber';

const daysAgoIso = (now: () => Date, days: number): string => new Date(now().getTime() - days * 24 * 60 * 60 * 1000).toISOString();

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Paid access requires a recorded period end. A `plan = 'paid'` row with no
 * expiry used to mean "forever"; now it means nothing, so a lost
 * cancellation webhook can no longer leave someone subscribed indefinitely.
 */
function isSubscriber(user: typeof users.$inferSelect, now: () => Date): boolean {
  if (user.plan !== 'paid' || !user.planExpiresAt) return false;
  return Date.parse(user.planExpiresAt) + SUBSCRIPTION_GRACE_DAYS * DAY_MS > now().getTime();
}

function hasCreditAccess(user: typeof users.$inferSelect, now: () => Date): boolean {
  return !!user.creditAccessUntil && user.creditAccessUntil > now().toISOString();
}

/** Credit rows that still count: unrevoked, unspent, and earned within the expiry window. */
function availableCreditRows(db: AppDb, userId: string, now: () => Date) {
  return db
    .select()
    .from(contributionCredits)
    .where(and(eq(contributionCredits.userId, userId), isNull(contributionCredits.spentRedemptionId), gte(contributionCredits.earnedAt, daysAgoIso(now, CREDIT_EXPIRY_DAYS))))
    .orderBy(asc(contributionCredits.earnedAt))
    .all()
    .filter((c) => !c.revokedAt);
}

/** Spendable credits: 10 per available credit row (section 6.3.2). */
export function creditBalance(db: AppDb, userId: string, now: () => Date = () => new Date()): number {
  return availableCreditRows(db, userId, now).length * CREDITS_PER_VERIFIED_REPORT;
}

export function entitlementLevel(user: typeof users.$inferSelect, now: () => Date = () => new Date()): EntitlementLevel {
  if (isSubscriber(user, now)) return 'subscriber';
  if (hasCreditAccess(user, now)) return 'contributor';
  return 'public';
}

export class RedeemError extends Error {
  constructor(public readonly status: 404 | 409, message: string) {
    super(message);
    this.name = 'RedeemError';
  }
}

/**
 * Spends 200 credits (the 20 oldest available credit rows) on 30 days of
 * access. Runs in one transaction -- better-sqlite3 is synchronous, so the
 * balance check and the spend can't interleave with another request, and a
 * double tap can't spend the same credits twice. Redemptions stack: a second
 * one extends from the end of the first. Refused while subscribed, so paying
 * users keep accumulating credits rather than burning them on a month they
 * already have.
 */
export function redeemFreeMonth(db: AppDb, userId: string, now: () => Date = () => new Date()): { accessUntil: string; balance: number } {
  return db.transaction((tx) => {
    const txDb = tx as unknown as AppDb;
    const user = txDb.select().from(users).where(eq(users.id, userId)).all()[0];
    if (!user) throw new RedeemError(404, 'Account not found.');
    if (isSubscriber(user, now)) throw new RedeemError(409, 'You already have an active subscription. Your credits will keep building up.');

    const rows = availableCreditRows(txDb, userId, now);
    const needed = CREDITS_PER_FREE_MONTH / CREDITS_PER_VERIFIED_REPORT;
    if (rows.length < needed) {
      throw new RedeemError(409, `You need ${CREDITS_PER_FREE_MONTH} credits to redeem a free month; you have ${rows.length * CREDITS_PER_VERIFIED_REPORT}.`);
    }

    const nowIso = now().toISOString();
    const base = user.creditAccessUntil && user.creditAccessUntil > nowIso ? user.creditAccessUntil : nowIso;
    const accessUntil = new Date(Date.parse(base) + FREE_MONTH_DAYS * DAY_MS).toISOString();
    const redemptionId = newId();

    txDb.insert(creditRedemptions).values({ id: redemptionId, userId, credits: CREDITS_PER_FREE_MONTH, accessFrom: base, accessUntil, createdAt: nowIso }).run();
    for (const row of rows.slice(0, needed)) {
      txDb.update(contributionCredits).set({ spentRedemptionId: redemptionId }).where(eq(contributionCredits.id, row.id)).run();
    }
    txDb.update(users).set({ creditAccessUntil: accessUntil }).where(eq(users.id, userId)).run();

    return { accessUntil, balance: (rows.length - needed) * CREDITS_PER_VERIFIED_REPORT };
  });
}

// --- Free tier (section 6.3.1) -------------------------------------------

/** Same 0.1-degree-cell-plus-radius key the client's pull cursor uses (src/sync/engine.ts's regionKey). */
export function regionKey(lat: number, lon: number, radiusMi: number): string {
  return `${lat.toFixed(1)},${lon.toFixed(1)},${radiusMi}`;
}

interface FreeTierCandidate {
  productId: string;
  reporters: number;
  storesCount: number;
}

/** Distinct reporters x distinct stores per product, over the trailing 90 days, within a region. */
function regionCandidates(db: AppDb, lat: number, lon: number, radiusMi: number, now: () => Date): FreeTierCandidate[] {
  const latDelta = radiusMi / 69;
  const lonDelta = radiusMi / (69 * Math.max(Math.cos((lat * Math.PI) / 180), 0.01));
  const cutoff = daysAgoIso(now, FREE_TIER_WINDOW_DAYS);

  const rows = db
    .select({ report: priceReports, store: stores })
    .from(priceReports)
    .innerJoin(stores, eq(priceReports.storeId, stores.id))
    .where(and(eq(priceReports.status, 'active'), gte(priceReports.createdAt, cutoff)))
    .all();

  const byProduct = new Map<string, { reporters: Set<string>; storeIds: Set<string> }>();
  for (const { report, store } of rows) {
    if (!report.productId) continue;
    if (store.lat == null || store.lon == null) continue;
    if (Math.abs(store.lat - lat) > latDelta || Math.abs(store.lon - lon) > lonDelta) continue;
    if (haversineMiles(lat, lon, store.lat, store.lon) > radiusMi) continue;

    const entry = byProduct.get(report.productId) ?? { reporters: new Set(), storeIds: new Set() };
    entry.reporters.add(report.userId);
    entry.storeIds.add(store.id);
    byProduct.set(report.productId, entry);
  }

  return [...byProduct.entries()].map(([productId, { reporters, storeIds }]) => ({
    productId,
    reporters: reporters.size,
    storesCount: storeIds.size,
  }));
}

/**
 * Recomputes the free tier for one region: top `FREE_TIER_PRODUCT_COUNT`
 * by distinct-reporters x distinct-stores, everything if the region has
 * fewer candidates than that, and a 7-day floor so a product entering the
 * set doesn't visibly churn back out the next day. Meant to run
 * periodically (see the maintenance timer in index.ts), not per-request.
 */
export function computeFreeTier(db: AppDb, lat: number, lon: number, radiusMi: number, now: () => Date = () => new Date()): void {
  const key = regionKey(lat, lon, radiusMi);
  const candidates = regionCandidates(db, lat, lon, radiusMi, now);
  const scored = candidates.map((c) => ({ productId: c.productId, score: c.reporters * c.storesCount })).sort((a, b) => b.score - a.score);

  const existing = db.select().from(freeTierProducts).where(eq(freeTierProducts.regionKey, key)).all();
  const existingById = new Map(existing.map((e) => [e.productId, e]));
  const sticky = new Set(existing.filter((e) => Date.parse(e.enteredAt) > now().getTime() - FREE_TIER_STICKY_DAYS * 24 * 60 * 60 * 1000).map((e) => e.productId));

  const topIds = scored.length <= FREE_TIER_PRODUCT_COUNT ? scored.map((s) => s.productId) : scored.slice(0, FREE_TIER_PRODUCT_COUNT).map((s) => s.productId);
  const keepIds = [...new Set([...topIds, ...sticky])];
  // Sticky products that fell out of this window's candidates entirely still get a (last, tied) rank so they remain in the set.
  const rankOf = new Map(scored.map((s, i) => [s.productId, i]));
  keepIds.sort((a, b) => (rankOf.get(a) ?? Infinity) - (rankOf.get(b) ?? Infinity));

  const today = now().toISOString();
  db.delete(freeTierProducts).where(eq(freeTierProducts.regionKey, key)).run();
  keepIds.forEach((productId, i) => {
    const prior = existingById.get(productId);
    db.insert(freeTierProducts).values({ regionKey: key, productId, rank: i + 1, enteredAt: prior?.enteredAt ?? today, computedAt: today }).run();
  });
}

/** How long a region's free set may go unrefreshed while people are pulling from it. */
const FREE_TIER_REFRESH_MS = 60 * 1000;
const lastFreeTierRefresh = new WeakMap<AppDb, Map<string, number>>();

/**
 * Brings a region's free set up to date on demand. Without this it only
 * changed when the periodic job ran, so in a young region (fewer than 25
 * products, where everything is meant to be free) a brand-new product stayed
 * locked for hours. Throttled to once a minute per region per process, so a
 * burst of pulls costs one scan; the scan is O(reports in the last 90 days),
 * which is fine while the dataset is small -- revisit if it isn't.
 */
export function ensureFreeTierFresh(db: AppDb, lat: number, lon: number, radiusMi: number, now: () => Date = () => new Date()): void {
  const key = regionKey(lat, lon, radiusMi);
  const seen = lastFreeTierRefresh.get(db) ?? new Map<string, number>();
  lastFreeTierRefresh.set(db, seen);
  const last = seen.get(key);
  if (last !== undefined && now().getTime() - last < FREE_TIER_REFRESH_MS) return;
  seen.set(key, now().getTime());
  // Same center as the periodic job and the pull cursor: the 0.1-degree cell the key is built from.
  computeFreeTier(db, Number(lat.toFixed(1)), Number(lon.toFixed(1)), radiusMi, now);
}

/**
 * A short fingerprint of the region's current free set. Clients compare it
 * between pulls: when a product enters the set, reports for it that an earlier
 * pull withheld as locked are behind the client's cursor and would never be
 * resent, so the client must start that region over.
 */
export function freeSetFingerprint(db: AppDb, lat: number, lon: number, radiusMi: number): string {
  const ids = [...freeTierProductIds(db, lat, lon, radiusMi)].sort();
  return createHash('sha1').update(ids.join('\n')).digest('hex').slice(0, 12);
}

export function freeTierProductIds(db: AppDb, lat: number, lon: number, radiusMi: number): Set<string> {
  const key = regionKey(lat, lon, radiusMi);
  return new Set(db.select({ productId: freeTierProducts.productId }).from(freeTierProducts).where(eq(freeTierProducts.regionKey, key)).all().map((r) => r.productId));
}

/** No live registry of "regions a pull was ever made for" -- so recompute around every distinct store location's 0.1-degree cell instead, at the default pull radius. Meant for the periodic maintenance timer. */
export function computeFreeTierForAllRegions(db: AppDb, defaultRadiusMi = 50, now: () => Date = () => new Date()): number {
  const seen = new Set<string>();
  let regions = 0;
  for (const s of db.select({ lat: stores.lat, lon: stores.lon }).from(stores).all()) {
    if (s.lat == null || s.lon == null) continue;
    const rLat = Math.round(s.lat * 10) / 10;
    const rLon = Math.round(s.lon * 10) / 10;
    const key = `${rLat},${rLon}`;
    if (seen.has(key)) continue;
    seen.add(key);
    computeFreeTier(db, rLat, rLon, defaultRadiusMi, now);
    regions++;
  }
  return regions;
}

// --- Contributor credits (section 6.3.2) ----------------------------------

function isVerified(report: typeof priceReports.$inferSelect, now: () => Date): boolean {
  if (report.confirmCount > 0) return true;
  return report.createdAt <= daysAgoIso(now, CREDIT_VERIFY_DAYS);
}

function isNonRedundant(db: AppDb, report: typeof priceReports.$inferSelect, now: () => Date): boolean {
  if (!report.productId || !report.storeId) return false;
  const cutoff = daysAgoIso(now, CREDIT_NONREDUNDANT_DAYS);
  const earlierSamePair = db
    .select()
    .from(priceReports)
    .where(and(eq(priceReports.productId, report.productId), eq(priceReports.storeId, report.storeId), gte(priceReports.observedDate, cutoff)))
    .all()
    .some((r) => r.id !== report.id && r.status !== 'deleted' && r.observedDate < report.observedDate);
  if (!earlierSamePair) return true;

  const current = db.select().from(currentPrices).where(and(eq(currentPrices.productId, report.productId), eq(currentPrices.storeId, report.storeId))).all()[0];
  if (!current || current.priceCents === 0) return false;
  return Math.abs(report.priceCents - current.priceCents) / current.priceCents >= CREDIT_PRICE_DELTA;
}

/**
 * Awards credit for every not-yet-evaluated active report that qualifies.
 * Each report is evaluated at most once (contribution_credits has a
 * unique index on report_id), so a report that doesn't yet qualify (too
 * new, unconfirmed) is simply picked up again on the next run once it
 * does. Meant to run periodically, not per-request.
 */
export function evaluateContributionCredits(db: AppDb, now: () => Date = () => new Date()): number {
  const alreadyCredited = new Set(db.select({ reportId: contributionCredits.reportId }).from(contributionCredits).all().map((r) => r.reportId));
  const activeReports = db.select().from(priceReports).where(eq(priceReports.status, 'active')).all();
  const today = now().toISOString().slice(0, 10);
  const earnedToday = new Map<string, number>();
  for (const c of db.select().from(contributionCredits).where(gte(contributionCredits.earnedAt, `${today}T00:00:00.000Z`)).all()) {
    earnedToday.set(c.userId, (earnedToday.get(c.userId) ?? 0) + 1);
  }

  let awarded = 0;
  for (const report of activeReports) {
    if (alreadyCredited.has(report.id)) continue;
    if (report.reviewReason === 'price_outlier' || report.reviewReason === 'flagged' || report.reviewReason === 'banned') continue;
    const author = db.select().from(users).where(eq(users.id, report.userId)).all()[0];
    if (!author || isUnverifiedTier(tierForUser(author))) continue;
    if ((earnedToday.get(report.userId) ?? 0) >= CREDIT_DAILY_CAP) continue;
    if (!isVerified(report, now)) continue;
    if (!isNonRedundant(db, report, now)) continue;

    db.insert(contributionCredits).values({ id: newId(), userId: report.userId, reportId: report.id, earnedAt: now().toISOString() }).run();
    earnedToday.set(report.userId, (earnedToday.get(report.userId) ?? 0) + 1);
    awarded++;
  }
  return awarded;
}

/** An upheld flag revokes the credit its report earned, if any (section 6.3.2). */
export function revokeCreditForReport(db: AppDb, reportId: string, now: () => Date = () => new Date()): void {
  db.update(contributionCredits).set({ revokedAt: now().toISOString() }).where(and(eq(contributionCredits.reportId, reportId))).run();
}

// --- Pull gating -----------------------------------------------------------

/** A public-level caller sees a locked summary (no price) for anything outside the free set. */
export function lockedSummaryFor(product: typeof products.$inferSelect, storeCount: number, newestDate: string): LockedSummary {
  return { productId: product.id, canonicalName: product.canonicalName, storeCount, reportCount: product.reportCount, newestDate };
}
