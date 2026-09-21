import { and, eq, lt, gte, count } from 'drizzle-orm';
import type { AppDb } from '../db/client.js';
import { rateLimitEvents } from '../db/schema.js';

/** Plan section 9.4, plus a per-device cap on the geo proxy (section 8.6 follow-up). */
export const LIMITS = {
  reportsPerUserHour: 60,
  reportsPerIpHour: 200,
  votesPerUserHour: 30,
  geoPerCallerHour: 120,
  /** Section 9.4/Phase 3, decision 9: anonymous AI parsing allowed, capped per caller per day. */
  parsePerCallerDay: 50,
} as const;

const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;

/**
 * Sliding-window check: counts this bucket's events in the window (an hour
 * by default) and, if under the limit, records one more. Old rows for the
 * bucket are pruned on every call so the table stays small without a
 * scheduled job.
 */
export function consumeRateLimit(db: AppDb, bucket: string, limit: number, now: () => Date = () => new Date(), windowMs: number = HOUR_MS): boolean {
  const windowStart = new Date(now().getTime() - windowMs).toISOString();
  db.delete(rateLimitEvents).where(and(eq(rateLimitEvents.bucket, bucket), lt(rateLimitEvents.createdAt, windowStart))).run();
  const [{ n }] = db
    .select({ n: count() })
    .from(rateLimitEvents)
    .where(and(eq(rateLimitEvents.bucket, bucket), gte(rateLimitEvents.createdAt, windowStart)))
    .all();
  if (n >= limit) return false;
  db.insert(rateLimitEvents).values({ bucket, createdAt: now().toISOString() }).run();
  return true;
}
