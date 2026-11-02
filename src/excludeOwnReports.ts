import PriceData from './PriceData';

/**
 * Own uploads come back from the server as community reports with the same id as the
 * local copy. Drop those so the local (trusted, untagged) copy is the only one shown.
 * `own` should include unsynced tombstones so a pending local delete doesn't resurface.
 */
export function excludeOwnReports(pulled: PriceData[], own: PriceData[]): PriceData[] {
  const ownIds = new Set(own.map((item) => item.id));
  return pulled.filter((item) => !ownIds.has(item.id));
}
