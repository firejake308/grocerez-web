import { and, eq, inArray } from 'drizzle-orm';
import type { AppDb } from '../db/client.js';
import { priceReports, users } from '../db/schema.js';

export type TrustTier = 'new' | 'restricted' | 'established' | 'trusted';

/** A report counts as confirmed once it has sat active and unflagged this long, even with no votes (section 9.2). */
export const CONFIRMED_AFTER_DAYS = 14;
/** Dismissed flags feed the flagger's trust downward: every three count as one bad report (section 9.3). */
export const DISMISSED_FLAGS_PER_BAD = 3;

/** Laplace-smoothed ratio of confirmed reports to bad ones (section 9.2). A fresh user scores exactly 0.5. */
export function trustScore(confirmedCount: number, badCount: number): number {
  return (confirmedCount + 1) / (confirmedCount + 3 * badCount + 2);
}

/** Tier is what the client shows; reports_count gates it before trust score matters at all. */
export function trustTier(reportsCount: number, confirmedCount: number, badCount: number): TrustTier {
  if (reportsCount < 3) return 'new';
  const score = trustScore(confirmedCount, badCount);
  if (score < 0.35) return 'restricted';
  if (score < 0.75) return 'established';
  return 'trusted';
}

type UserCounts = Pick<typeof users.$inferSelect, 'reportsCount' | 'confirmedCount' | 'upheldFlagsCount' | 'dismissedFlagsCount'>;

export function badCount(u: Pick<UserCounts, 'upheldFlagsCount' | 'dismissedFlagsCount'>): number {
  return u.upheldFlagsCount + Math.floor(u.dismissedFlagsCount / DISMISSED_FLAGS_PER_BAD);
}

export function tierForUser(u: UserCounts): TrustTier {
  return trustTier(u.reportsCount, u.confirmedCount, badCount(u));
}

export const isUnverifiedTier = (tier: TrustTier): boolean => tier === 'new' || tier === 'restricted';

/**
 * Recounts a user's reports and confirmations from their actual rows and
 * stores the resulting trust score. Called after any confirmation, flag
 * resolution, or ban touching them, and for everyone by the periodic
 * maintenance run (the 14-day rule changes with no event to hook).
 */
export function recomputeUserTrust(db: AppDb, userId: string, now: () => Date = () => new Date()): { trustScore: number; tier: TrustTier } | null {
  const user = db.select().from(users).where(eq(users.id, userId)).all()[0];
  if (!user) return null;

  const rows = db
    .select({ status: priceReports.status, confirmCount: priceReports.confirmCount, flagWeight: priceReports.flagWeight, createdAt: priceReports.createdAt })
    .from(priceReports)
    .where(and(eq(priceReports.userId, userId), inArray(priceReports.status, ['active', 'hidden'])))
    .all();

  const cutoff = now().getTime() - CONFIRMED_AFTER_DAYS * 86_400_000;
  const confirmedCount = rows.filter(
    (r) => r.status === 'active' && (r.confirmCount >= 1 || (r.flagWeight === 0 && Date.parse(r.createdAt) <= cutoff)),
  ).length;
  const reportsCount = rows.length;
  const bad = badCount(user);
  const score = trustScore(confirmedCount, bad);

  db.update(users).set({ trustScore: score, confirmedCount, reportsCount }).where(eq(users.id, userId)).run();
  return { trustScore: score, tier: trustTier(reportsCount, confirmedCount, bad) };
}

export function recomputeAllTrust(db: AppDb, now: () => Date = () => new Date()): number {
  const ids = db.select({ id: users.id }).from(users).all();
  for (const { id } of ids) recomputeUserTrust(db, id, now);
  return ids.length;
}
