import { and, eq, lt, gte, count } from 'drizzle-orm';
import type { AppDb } from '../db/client.js';
import { rateLimitEvents } from '../db/schema.js';

/** Plan section 9.4, plus a per-device cap on the geo proxy (section 8.6 follow-up). */
export const LIMITS = {
  reportsPerUserHour: 60,
  reportsPerIpHour: 200,
  votesPerUserHour: 30,
  geoPerCallerHour: 120,
} as const;

const WINDOW_MS = 60 * 60 * 1000;

/**
 * Sliding-window check: counts this bucket's events in the last hour and,
 * if under the limit, records one more. Old rows for the bucket are pruned
 * on every call so the table stays small without a scheduled job.
 */
export function consumeRateLimit(db: AppDb, bucket: string, limit: number, now: () => Date = () => new Date()): boolean {
  const windowStart = new Date(now().getTime() - WINDOW_MS).toISOString();
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
