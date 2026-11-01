import { eq, sql } from 'drizzle-orm';
import type { AppDb } from '../db/client.js';
import { currentPrices, priceReports, stores } from '../db/schema.js';
import { refreshCurrentPrice } from './freshness.js';
import { nearbyStores, type GeoDeps } from './geo.js';
import { isAddressOnlyStore, normalizeKeyPart } from './stores.js';

export interface BackfillOptions {
  /** Without this, stores are looked up and printed but no report is moved. */
  apply: boolean;
  log?: (line: string) => void;
}

export interface BackfillSummary {
  addressOnlyStores: number;
  resolved: number;
  notFound: number;
  noCoordinates: number;
  reportsMoved: number;
}

/**
 * One-time cleanup for reports saved at an address-only "store" (see
 * isAddressOnlyStore): asks the geo lookup what store is at that spot and,
 * with `apply`, moves the reports to it. Reports are grouped by their store
 * row, and an address looked up once is reused for every row that shares it.
 * Even without `apply`, stores Overpass finds are recorded in the stores
 * table, exactly as a normal lookup would.
 */
export async function backfillStoreNames(db: AppDb, deps: GeoDeps, { apply, log = () => {} }: BackfillOptions): Promise<BackfillSummary> {
  const summary: BackfillSummary = { addressOnlyStores: 0, resolved: 0, notFound: 0, noCoordinates: 0, reportsMoved: 0 };
  // address -> the named store found for it, or null when the lookup came back empty
  const byAddress = new Map<string, { id: string; name: string } | null>();

  const candidates = db.select().from(stores).all().filter(isAddressOnlyStore);
  for (const old of candidates) {
    const reports = db.select().from(priceReports).where(eq(priceReports.storeId, old.id)).all();
    if (reports.length === 0) continue;
    summary.addressOnlyStores++;

    const address = old.address ?? old.name;
    const key = normalizeKeyPart(address);
    let found = byAddress.get(key);
    if (found === undefined) {
      if (old.lat === null || old.lon === null) {
        summary.noCoordinates++;
        log(`${address} -> (skipped: no coordinates, ${reports.length} report(s))`);
        continue;
      }
      const best = (await nearbyStores(db, deps, old.lat, old.lon))[0];
      found = best ? { id: best.storeId, name: best.name } : null;
      byAddress.set(key, found);
      log(`${address} -> ${found ? found.name : '(no store found)'}`);
    }

    if (!found) {
      summary.notFound++;
      continue;
    }
    summary.resolved++;
    if (!apply) continue;

    const productIds = Array.from(new Set(reports.map((r) => r.productId).filter((id): id is string => !!id)));
    db.update(priceReports).set({ storeId: found.id }).where(eq(priceReports.storeId, old.id)).run();
    for (const productId of productIds) {
      refreshCurrentPrice(db, productId, found.id);
      refreshCurrentPrice(db, productId, old.id); // nothing left there, so this clears its current_prices row
    }
    const stillUsed =
      db.select({ n: sql<number>`count(*)` }).from(priceReports).where(eq(priceReports.storeId, old.id)).all()[0].n +
      db.select({ n: sql<number>`count(*)` }).from(currentPrices).where(eq(currentPrices.storeId, old.id)).all()[0].n;
    if (stillUsed === 0) db.delete(stores).where(eq(stores.id, old.id)).run();
    summary.reportsMoved += reports.length;
  }
  return summary;
}
