import type PriceData from '../PriceData';
import type { Point } from './engine';
import type { HomeArea } from './storage';

/**
 * Device position, but only if the user has already granted geolocation --
 * background sync must never be the thing that pops the permission prompt
 * (the scanner does that, at a moment the user expects it). Browsers
 * without the Permissions API for geolocation (Safari) skip this source.
 */
async function currentPositionIfGranted(): Promise<Point | null> {
  if (typeof navigator === 'undefined' || !navigator.geolocation || !navigator.permissions?.query) return null;
  try {
    const status = await navigator.permissions.query({ name: 'geolocation' });
    if (status.state !== 'granted') return null;
  } catch {
    return null;
  }
  return new Promise<Point | null>((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      () => resolve(null),
      { timeout: 5000, maximumAge: 10 * 60_000 },
    );
  });
}

/** Plan section 7's order: device position, then the newest located own report, then the home area. */
export async function getSyncLocation(priceData: PriceData[], homeArea: HomeArea | null): Promise<Point | null> {
  const fromDevice = await currentPositionIfGranted();
  if (fromDevice) return fromDevice;

  const located = priceData
    .filter((r) => !r.deletedAt && typeof r.latitude === 'number' && typeof r.longitude === 'number')
    .sort((a, b) => b.date.localeCompare(a.date))[0];
  if (located) return { lat: located.latitude as number, lon: located.longitude as number };

  if (homeArea) return { lat: homeArea.lat, lon: homeArea.lon };
  return null;
}
