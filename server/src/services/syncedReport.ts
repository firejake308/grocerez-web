import type { priceReports, stores, users } from '../db/schema.js';
import type { SyncedPriceReport } from '../../../shared/types.js';
import { isStaleReport } from './freshness.js';
import { tierForUser } from './trust.js';

export interface ReportRow {
  report: typeof priceReports.$inferSelect;
  store: typeof stores.$inferSelect;
  author: typeof users.$inferSelect;
}

/** The wire shape of a report, shared by /api/sync/pull and /api/discover. `today` is todayOf(now) so one request uses one date. */
export function toSyncedReport({ report, store, author }: ReportRow, today: string, myVote: 'confirm' | 'flag' | null = null): SyncedPriceReport {
  return {
    id: report.id,
    seq: report.seq,
    userId: report.userId,
    authorTier: tierForUser(author),
    productId: report.productId ?? '',
    storeId: report.storeId ?? '',
    storeName: store.name,
    itemName: report.itemName,
    brand: report.brand,
    tags: JSON.parse(report.tags) as string[],
    quantity: report.quantity,
    quantityUnits: report.quantityUnits,
    priceCents: report.priceCents,
    observedDate: report.observedDate,
    expiresAt: report.expiresAt,
    isSale: report.isSale,
    status: report.status,
    reviewReason: report.reviewReason,
    confirmCount: report.confirmCount,
    isStale: isStaleReport(report, today),
    myVote,
    updatedAt: report.updatedAt,
  };
}
