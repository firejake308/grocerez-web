import { and, eq, isNull } from 'drizzle-orm';
import type { AppDb } from '../db/client.js';
import { priceReports, reportVotes, users } from '../db/schema.js';
import { newId } from '../lib/ids.js';
import { refreshCurrentPrice, todayOf } from './freshness.js';
import { consumeRateLimit, LIMITS } from './rateLimit.js';
import { recomputeUserTrust } from './trust.js';

export type FlagReason = 'wrong_price' | 'wrong_item' | 'expired' | 'duplicate' | 'spam' | 'other';

/** Combined flag weight from at least this many distinct users hides a report pending review (section 9.3). */
export const HIDE_FLAG_WEIGHT = 1.5;
export const HIDE_MIN_FLAGGERS = 2;
/** Confirmations that release a restricted author's report from `new_user` review (section 9.4). */
export const RELEASE_CONFIRMATIONS = 2;

export class VoteError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'VoteError';
  }
}

export interface ReportVoteState {
  reportId: string;
  status: 'active' | 'hidden' | 'deleted';
  reviewReason: string | null;
  confirmCount: number;
  flagWeight: number;
  myVote: 'confirm' | 'flag' | null;
}

/**
 * Recounts a report's votes from the rows, applies the hide / release
 * transitions, bumps its freshness date to the latest confirmation, then
 * recomputes the author's trust and the current price it feeds.
 */
export function recountReport(db: AppDb, reportId: string, now: () => Date = () => new Date()): void {
  const report = db.select().from(priceReports).where(eq(priceReports.id, reportId)).all()[0];
  if (!report) return;

  const votes = db.select().from(reportVotes).where(eq(reportVotes.reportId, reportId)).all();
  const confirms = votes.filter((v) => v.kind === 'confirm');
  const openFlags = votes.filter((v) => v.kind === 'flag' && v.resolution === null);
  const flagWeight = openFlags.reduce((sum, v) => sum + v.weight, 0);

  const latestConfirmDate = confirms.map((v) => v.createdAt.slice(0, 10)).sort().at(-1);
  const freshnessDate = latestConfirmDate && latestConfirmDate > report.observedDate ? latestConfirmDate : report.observedDate;

  let status = report.status;
  let reviewReason = report.reviewReason;
  if (status === 'hidden' && reviewReason === 'new_user' && confirms.length >= RELEASE_CONFIRMATIONS) {
    status = 'active';
    reviewReason = null;
  }
  if (status === 'active' && flagWeight >= HIDE_FLAG_WEIGHT && openFlags.length >= HIDE_MIN_FLAGGERS) {
    status = 'hidden';
    reviewReason = 'flagged';
  }

  db.update(priceReports)
    .set({ confirmCount: confirms.length, flagWeight, freshnessDate, status, reviewReason })
    .where(eq(priceReports.id, reportId))
    .run();

  recomputeUserTrust(db, report.userId, now);
  if (report.productId && report.storeId) refreshCurrentPrice(db, report.productId, report.storeId, now);
}

function stateOf(db: AppDb, reportId: string, userId: string): ReportVoteState {
  const report = db.select().from(priceReports).where(eq(priceReports.id, reportId)).all()[0];
  if (!report) throw new VoteError(404, 'Report not found.');
  const mine = db.select().from(reportVotes).where(and(eq(reportVotes.reportId, reportId), eq(reportVotes.userId, userId))).all()[0];
  return {
    reportId,
    status: report.status,
    reviewReason: report.reviewReason,
    confirmCount: report.confirmCount,
    flagWeight: report.flagWeight,
    myVote: mine ? mine.kind : null,
  };
}

export function castVote(
  db: AppDb,
  input: { userId: string; reportId: string; kind: 'confirm' | 'flag'; reason?: FlagReason; note?: string },
  now: () => Date = () => new Date(),
): ReportVoteState {
  const report = db.select().from(priceReports).where(eq(priceReports.id, input.reportId)).all()[0];
  if (!report || report.status === 'deleted') throw new VoteError(404, 'Report not found.');
  if (report.userId === input.userId) throw new VoteError(403, 'You cannot vote on your own report.');
  if (input.kind === 'flag' && !input.reason) throw new VoteError(400, 'A flag needs a reason.');

  const voter = db.select().from(users).where(eq(users.id, input.userId)).all()[0];
  if (!voter) throw new VoteError(401, 'Sign-in required.');
  if (voter.status === 'banned') throw new VoteError(403, 'This account cannot vote.');

  const existing = db
    .select()
    .from(reportVotes)
    .where(and(eq(reportVotes.reportId, input.reportId), eq(reportVotes.userId, input.userId)))
    .all()[0];
  if (existing?.resolution) throw new VoteError(409, 'This flag has already been reviewed.');
  if (existing?.kind === input.kind && input.kind === 'confirm') return stateOf(db, input.reportId, input.userId);

  if (!consumeRateLimit(db, `vote:${input.userId}`, LIMITS.votesPerUserHour, now)) {
    throw new VoteError(429, 'Too many votes in the last hour. Try again later.');
  }

  if (existing) db.delete(reportVotes).where(eq(reportVotes.id, existing.id)).run();
  db.insert(reportVotes)
    .values({
      id: newId(),
      reportId: input.reportId,
      userId: input.userId,
      kind: input.kind,
      reason: input.kind === 'flag' ? input.reason : null,
      note: input.kind === 'flag' ? input.note?.trim().slice(0, 500) || null : null,
      // A flag's weight is the voter's trust at the time: a fresh account counts about a third of a trusted one.
      weight: input.kind === 'flag' ? voter.trustScore : 0,
      createdAt: now().toISOString(),
    })
    .run();

  recountReport(db, input.reportId, now);
  return stateOf(db, input.reportId, input.userId);
}

/** Withdraws the caller's vote. A flag an admin already resolved stays on record. */
export function removeVote(db: AppDb, userId: string, reportId: string, now: () => Date = () => new Date()): ReportVoteState {
  const existing = db
    .select()
    .from(reportVotes)
    .where(and(eq(reportVotes.reportId, reportId), eq(reportVotes.userId, userId), isNull(reportVotes.resolution)))
    .all()[0];
  if (existing) {
    db.delete(reportVotes).where(eq(reportVotes.id, existing.id)).run();
    recountReport(db, reportId, now);
  }
  return stateOf(db, reportId, userId);
}

export { todayOf };
