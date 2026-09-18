export type TrustTier = 'new' | 'restricted' | 'established' | 'trusted';

/**
 * Laplace-smoothed ratio of confirmed reports to upheld flags (plan section
 * 9.2). Confirmed and bad both default to 0 today since votes aren't
 * implemented yet (Phase 2); a fresh user scores exactly 0.5.
 */
export function trustScore(confirmedCount: number, upheldFlagsCount: number): number {
  return (confirmedCount + 1) / (confirmedCount + 3 * upheldFlagsCount + 2);
}

/** Tier is what the client shows; reports_count gates it before trust score matters at all. */
export function trustTier(reportsCount: number, confirmedCount: number, upheldFlagsCount: number): TrustTier {
  if (reportsCount < 3) return 'new';
  const score = trustScore(confirmedCount, upheldFlagsCount);
  if (score < 0.35) return 'restricted';
  if (score < 0.75) return 'established';
  return 'trusted';
}
