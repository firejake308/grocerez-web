const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

/**
 * Standard geohash encoding (https://en.wikipedia.org/wiki/Geohash). Used
 * to bucket coordinates into ~150m cells (precision 7, plan section 8.5)
 * for cheap store deduplication -- two reports in the same cell with the
 * same chain name are the same store.
 */
export function geohash(lat: number, lon: number, precision = 7): string {
  const latRange: [number, number] = [-90, 90];
  const lonRange: [number, number] = [-180, 180];
  let isEven = true;
  let bit = 0;
  let ch = 0;
  let result = '';

  while (result.length < precision) {
    if (isEven) {
      const mid = (lonRange[0] + lonRange[1]) / 2;
      if (lon >= mid) {
        ch |= 1 << (4 - bit);
        lonRange[0] = mid;
      } else {
        lonRange[1] = mid;
      }
    } else {
      const mid = (latRange[0] + latRange[1]) / 2;
      if (lat >= mid) {
        ch |= 1 << (4 - bit);
        latRange[0] = mid;
      } else {
        latRange[1] = mid;
      }
    }
    isEven = !isEven;
    if (bit < 4) {
      bit++;
    } else {
      result += BASE32[ch];
      bit = 0;
      ch = 0;
    }
  }
  return result;
}

const EARTH_RADIUS_MI = 3958.8;

/** Great-circle distance in miles, for the pull endpoint's radius filter (plan section 7). */
export function haversineMiles(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_MI * Math.asin(Math.sqrt(a));
}

/** Same distance in meters, for the ~150m store-proximity checks (plan section 8.6). */
export function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  return haversineMiles(lat1, lon1, lat2, lon2) * 1609.344;
}
