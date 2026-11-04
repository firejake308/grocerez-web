import { eq, inArray, isNull, or } from 'drizzle-orm';
import type { AppDb } from '../db/client.js';
import { contributionCredits, currentPrices, priceReports, products, reportVotes, stores } from '../db/schema.js';
import { refreshProductFromReports } from './products.js';

export interface UnlocatedStore {
  id: string;
  name: string;
  address: string | null;
  reports: number;
  activeReports: number;
}

export interface UnlocatedSummary {
  stores: UnlocatedStore[];
  reports: number;
  activeReports: number;
  /** Rows removed (only when applying). */
  deleted: { reports: number; votes: number; credits: number; currentPrices: number; stores: number };
}

/**
 * Stores without coordinates predate the rule that every store has a location
 * (see the stores_require_location_* triggers). No one can be shown their
 * prices -- we can't tell who is near -- so they are dead weight. Lists them
 * and, with `apply`, deletes them with everything that hangs off them, in one
 * transaction. Photo files on disk are left to the normal retention sweep.
 */
export function cleanupUnlocatedStores(db: AppDb, { apply }: { apply: boolean }): UnlocatedSummary {
  const run = (tx: AppDb): UnlocatedSummary => {
    const orphanStores = tx.select().from(stores).where(or(isNull(stores.lat), isNull(stores.lon))).all();
    const summary: UnlocatedSummary = {
      stores: [],
      reports: 0,
      activeReports: 0,
      deleted: { reports: 0, votes: 0, credits: 0, currentPrices: 0, stores: 0 },
    };
    if (orphanStores.length === 0) return summary;

    const storeIds = orphanStores.map((s) => s.id);
    const reports = tx.select().from(priceReports).where(inArray(priceReports.storeId, storeIds)).all();
    for (const store of orphanStores) {
      const mine = reports.filter((r) => r.storeId === store.id);
      summary.stores.push({ id: store.id, name: store.name, address: store.address, reports: mine.length, activeReports: mine.filter((r) => r.status === 'active').length });
    }
    summary.reports = reports.length;
    summary.activeReports = reports.filter((r) => r.status === 'active').length;
    if (!apply) return summary;

    const reportIds = reports.map((r) => r.id);
    const productIds = [...new Set(reports.map((r) => r.productId).filter((id): id is string => !!id))];
    if (reportIds.length > 0) {
      // current_prices can point at these reports from a store that does have coordinates (contested_report_id).
      for (const row of tx.select().from(currentPrices).where(inArray(currentPrices.contestedReportId, reportIds)).all()) {
        tx.update(currentPrices).set({ contestedReportId: null }).where(eq(currentPrices.reportId, row.reportId)).run();
      }
      summary.deleted.votes = tx.delete(reportVotes).where(inArray(reportVotes.reportId, reportIds)).run().changes;
      summary.deleted.credits = tx.delete(contributionCredits).where(inArray(contributionCredits.reportId, reportIds)).run().changes;
    }
    summary.deleted.currentPrices = tx.delete(currentPrices).where(inArray(currentPrices.storeId, storeIds)).run().changes;
    if (reportIds.length > 0) summary.deleted.reports = tx.delete(priceReports).where(inArray(priceReports.id, reportIds)).run().changes;
    summary.deleted.stores = tx.delete(stores).where(inArray(stores.id, storeIds)).run().changes;

    for (const productId of productIds) {
      if (tx.select({ id: products.id }).from(products).where(eq(products.id, productId)).all()[0]) refreshProductFromReports(tx, productId);
    }
    return summary;
  };
  return apply ? db.transaction((tx) => run(tx as unknown as AppDb)) : run(db);
}
