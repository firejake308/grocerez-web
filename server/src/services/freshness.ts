import { and, eq, inArray } from 'drizzle-orm';
import type { AppDb } from '../db/client.js';
import { currentPrices, priceReports, users } from '../db/schema.js';
import { isUnverifiedTier, tierForUser } from './trust.js';

/** Section 10: no confirmation or rescan in this long, and a price stops being "current". */
export const STALE_AFTER_DAYS = 45;
/** Section 10's override applies only when the trusted report is at most this much older than the unverified one. */
export const OVERRIDE_WINDOW_DAYS = 30;
/** ...and the two prices disagree by more than this fraction. */
export const OVERRIDE_DISAGREEMENT = 0.15;

export const todayOf = (now: Date): string => now.toISOString().slice(0, 10);

const daysBetween = (fromDate: string, toDate: string): number =>
  Math.round((Date.parse(toDate) - Date.parse(fromDate)) / 86_400_000);

export function isStaleReport(
  r: { expiresAt: string | null; freshnessDate: string; observedDate: string },
  today: string,
): boolean {
  if (r.expiresAt && r.expiresAt < today) return true;
  const reference = r.freshnessDate || r.observedDate;
  return daysBetween(reference, today) > STALE_AFTER_DAYS;
}

/**
 * Rebuilds the current_prices row for one (product, store) from its active
 * reports. Newest observed_date wins, ties to the latest push -- except
 * (section 10) when the newest is from an unverified author and a recent
 * report from an established+ author disagrees by more than 15%: then the
 * trusted one is current and the newer one is kept as `contested` so the
 * client can show it as "reported $X on <date> (unverified)".
 */
export function refreshCurrentPrice(db: AppDb, productId: string, storeId: string, now: () => Date = () => new Date()): void {
  const active = db
    .select()
    .from(priceReports)
    .where(and(eq(priceReports.productId, productId), eq(priceReports.storeId, storeId), eq(priceReports.status, 'active')))
    .all()
    .sort((a, b) => (a.observedDate === b.observedDate ? b.seq - a.seq : a.observedDate < b.observedDate ? 1 : -1));

  const where = and(eq(currentPrices.productId, productId), eq(currentPrices.storeId, storeId));
  if (active.length === 0) {
    db.delete(currentPrices).where(where).run();
    return;
  }

  const authorIds = Array.from(new Set(active.map((r) => r.userId)));
  const authors = new Map(db.select().from(users).where(inArray(users.id, authorIds)).all().map((u) => [u.id, u]));
  const tierOf = (r: (typeof active)[number]) => {
    const author = authors.get(r.userId);
    return author ? tierForUser(author) : 'new';
  };

  const newest = active[0];
  let current = newest;
  let contested: (typeof active)[number] | null = null;

  if (isUnverifiedTier(tierOf(newest))) {
    const trusted = active.find(
      (r) =>
        r !== newest &&
        !isUnverifiedTier(tierOf(r)) &&
        daysBetween(r.observedDate, newest.observedDate) <= OVERRIDE_WINDOW_DAYS &&
        Math.abs(r.priceCents - newest.priceCents) / r.priceCents > OVERRIDE_DISAGREEMENT,
    );
    if (trusted) {
      current = trusted;
      contested = newest;
    }
  }

  const row = {
    productId,
    storeId,
    reportId: current.id,
    priceCents: current.priceCents,
    observedDate: current.observedDate,
    expiresAt: current.expiresAt,
    confidence: authors.get(current.userId)?.trustScore ?? 0.5,
    isStale: isStaleReport(current, todayOf(now())),
    contestedReportId: contested?.id ?? null,
  };

  const existing = db.select({ productId: currentPrices.productId }).from(currentPrices).where(where).all()[0];
  if (existing) db.update(currentPrices).set(row).where(where).run();
  else db.insert(currentPrices).values(row).run();
}
