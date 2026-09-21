import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { AppDb } from '../db/client.js';
import { currentPrices, priceReports, products, productTokens, reportVotes, stores, users } from '../db/schema.js';
import { revokeCreditForReport } from './entitlements.js';
import { refreshCurrentPrice } from './freshness.js';
import { followMerge, refreshProductFromReports } from './products.js';
import { recomputeUserTrust } from './trust.js';

export class AdminError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'AdminError';
  }
}

export interface FlagListing {
  flagId: string;
  reason: string | null;
  note: string | null;
  weight: number;
  createdAt: string;
  resolution: string | null;
  flagger: { id: string; email: string; trustScore: number };
  report: {
    id: string;
    status: string;
    reviewReason: string | null;
    itemName: string;
    brand: string;
    priceCents: number;
    observedDate: string;
    storeName: string | null;
    flagWeight: number;
    confirmCount: number;
    author: { id: string; email: string; trustScore: number };
  };
}

export function listFlags(db: AppDb, status: 'open' | 'resolved' = 'open'): FlagListing[] {
  const rows = db
    .select({ vote: reportVotes, report: priceReports, storeName: stores.name })
    .from(reportVotes)
    .innerJoin(priceReports, eq(reportVotes.reportId, priceReports.id))
    .leftJoin(stores, eq(priceReports.storeId, stores.id))
    .where(eq(reportVotes.kind, 'flag'))
    .all()
    .filter((r) => (status === 'open' ? r.vote.resolution === null : r.vote.resolution !== null));

  const userIds = Array.from(new Set(rows.flatMap((r) => [r.vote.userId, r.report.userId])));
  const userMap = new Map(
    (userIds.length ? db.select().from(users).where(inArray(users.id, userIds)).all() : []).map((u) => [u.id, u]),
  );
  const brief = (id: string) => {
    const u = userMap.get(id);
    return { id, email: u?.email ?? '?', trustScore: u?.trustScore ?? 0 };
  };

  return rows
    .sort((a, b) => a.vote.createdAt.localeCompare(b.vote.createdAt))
    .map(({ vote, report, storeName }) => ({
      flagId: vote.id,
      reason: vote.reason,
      note: vote.note,
      weight: vote.weight,
      createdAt: vote.createdAt,
      resolution: vote.resolution,
      flagger: brief(vote.userId),
      report: {
        id: report.id,
        status: report.status,
        reviewReason: report.reviewReason,
        itemName: report.itemName,
        brand: report.brand,
        priceCents: report.priceCents,
        observedDate: report.observedDate,
        storeName,
        flagWeight: report.flagWeight,
        confirmCount: report.confirmCount,
        author: brief(report.userId),
      },
    }));
}

/**
 * Resolves every open flag on the flagged report at once (section 9.3):
 * upheld keeps it hidden and counts against the author; dismissed restores
 * it and counts against each flagger.
 */
export function resolveFlag(db: AppDb, flagId: string, resolution: 'upheld' | 'dismissed', now: () => Date = () => new Date()): { reportId: string; resolvedFlags: number } {
  const flag = db.select().from(reportVotes).where(eq(reportVotes.id, flagId)).all()[0];
  if (!flag || flag.kind !== 'flag') throw new AdminError(404, 'Flag not found.');
  if (flag.resolution) throw new AdminError(409, `Already ${flag.resolution}.`);
  const report = db.select().from(priceReports).where(eq(priceReports.id, flag.reportId)).all()[0];
  if (!report) throw new AdminError(404, 'Report not found.');

  const openFlags = db
    .select()
    .from(reportVotes)
    .where(and(eq(reportVotes.reportId, report.id), eq(reportVotes.kind, 'flag'), isNull(reportVotes.resolution)))
    .all();
  const resolvedAt = now().toISOString();
  for (const f of openFlags) {
    db.update(reportVotes).set({ resolution, resolvedAt }).where(eq(reportVotes.id, f.id)).run();
  }

  if (resolution === 'upheld') {
    db.update(priceReports).set({ status: 'hidden', reviewReason: 'flagged', flagWeight: 0 }).where(eq(priceReports.id, report.id)).run();
    const author = db.select().from(users).where(eq(users.id, report.userId)).all()[0];
    if (author) db.update(users).set({ upheldFlagsCount: author.upheldFlagsCount + 1 }).where(eq(users.id, author.id)).run();
    // Section 6.3.2: an upheld flag revokes whatever contribution credit this report earned.
    revokeCreditForReport(db, report.id, now);
  } else {
    const restored = report.status === 'hidden' && report.reviewReason === 'flagged';
    db.update(priceReports)
      .set({ flagWeight: 0, ...(restored ? { status: 'active', reviewReason: null } : {}) })
      .where(eq(priceReports.id, report.id))
      .run();
    for (const f of openFlags) {
      const flagger = db.select().from(users).where(eq(users.id, f.userId)).all()[0];
      if (flagger) {
        db.update(users).set({ dismissedFlagsCount: flagger.dismissedFlagsCount + 1 }).where(eq(users.id, flagger.id)).run();
        recomputeUserTrust(db, flagger.id, now);
      }
    }
  }

  recomputeUserTrust(db, report.userId, now);
  if (report.productId && report.storeId) refreshCurrentPrice(db, report.productId, report.storeId, now);
  return { reportId: report.id, resolvedFlags: openFlags.length };
}

/** Section 8.4: points `source` at `target`, moves its reports, re-points current prices, copies its tokens. */
export function mergeProducts(db: AppDb, sourceId: string, targetIdRaw: string, now: () => Date = () => new Date()): { targetId: string; movedReports: number } {
  const source = db.select().from(products).where(eq(products.id, sourceId)).all()[0];
  if (!source) throw new AdminError(404, 'Source product not found.');
  if (source.mergedInto) throw new AdminError(409, `Already merged into ${source.mergedInto}.`);
  const targetId = followMerge(db, targetIdRaw);
  if (!targetId) throw new AdminError(404, 'Target product not found.');
  if (targetId === sourceId) throw new AdminError(400, 'A product cannot be merged into itself.');

  const affectedStores = Array.from(
    new Set(
      db.select({ storeId: priceReports.storeId }).from(priceReports).where(eq(priceReports.productId, sourceId)).all()
        .map((r) => r.storeId)
        .filter((s): s is string => s !== null),
    ),
  );
  const moved = db.update(priceReports).set({ productId: targetId }).where(eq(priceReports.productId, sourceId)).run().changes;

  db.delete(currentPrices).where(eq(currentPrices.productId, sourceId)).run();
  for (const storeId of affectedStores) refreshCurrentPrice(db, targetId, storeId, now);

  for (const { token } of db.select({ token: productTokens.token }).from(productTokens).where(eq(productTokens.productId, sourceId)).all()) {
    db.insert(productTokens).values({ productId: targetId, token }).onConflictDoNothing().run();
  }

  db.update(products).set({ mergedInto: targetId, reportCount: 0, medianPriceCents: null }).where(eq(products.id, sourceId)).run();
  db.update(products).set({ possibleDuplicateOf: null }).where(eq(products.possibleDuplicateOf, sourceId)).run();
  refreshProductFromReports(db, targetId);
  return { targetId, movedReports: moved };
}

/** Banning hides every active report; lifting a ban restores exactly the ones the ban hid (section 9.4). */
export function setUserStatus(db: AppDb, userId: string, status: 'active' | 'restricted' | 'banned', now: () => Date = () => new Date()): { affectedReports: number } {
  const user = db.select().from(users).where(eq(users.id, userId)).all()[0];
  if (!user) throw new AdminError(404, 'User not found.');
  db.update(users).set({ status }).where(eq(users.id, userId)).run();

  let affected: { productId: string | null; storeId: string | null }[] = [];
  if (status === 'banned') {
    affected = db.select({ productId: priceReports.productId, storeId: priceReports.storeId }).from(priceReports)
      .where(and(eq(priceReports.userId, userId), eq(priceReports.status, 'active'))).all();
    db.update(priceReports).set({ status: 'hidden', reviewReason: 'banned' })
      .where(and(eq(priceReports.userId, userId), eq(priceReports.status, 'active'))).run();
  } else if (user.status === 'banned') {
    affected = db.select({ productId: priceReports.productId, storeId: priceReports.storeId }).from(priceReports)
      .where(and(eq(priceReports.userId, userId), eq(priceReports.status, 'hidden'), eq(priceReports.reviewReason, 'banned'))).all();
    db.update(priceReports).set({ status: 'active', reviewReason: null })
      .where(and(eq(priceReports.userId, userId), eq(priceReports.status, 'hidden'), eq(priceReports.reviewReason, 'banned'))).run();
  }

  const pairs = new Set<string>();
  for (const { productId, storeId } of affected) {
    if (productId && storeId) pairs.add(`${productId}|${storeId}`);
  }
  for (const pair of pairs) {
    const [productId, storeId] = pair.split('|');
    refreshProductFromReports(db, productId);
    refreshCurrentPrice(db, productId, storeId, now);
  }
  recomputeUserTrust(db, userId, now);
  return { affectedReports: affected.length };
}
