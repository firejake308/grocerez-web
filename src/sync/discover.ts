/**
 * Home screen "discover" samples: when we don't yet know where the user is,
 * pull a handful of reports from a few scattered US metro areas so the home
 * screen shows real activity instead of an empty state. Purely a nudge
 * toward setting a home area / location (plan section 7 covers the real,
 * located pull).
 */
import type PriceData from '../PriceData';
import type { Point } from './engine';
import { communityToPriceData } from './engine';
import type { SyncApi } from './api';

/** A handful of large, spread-out US metros, enough to usually find *something* to show. */
export const DISCOVER_METROS: Point[] = [
  { lat: 40.7128, lon: -74.006 }, // New York
  { lat: 34.0522, lon: -118.2437 }, // Los Angeles
  { lat: 41.8781, lon: -87.6298 }, // Chicago
  { lat: 29.7604, lon: -95.3698 }, // Houston
  { lat: 33.4484, lon: -112.074 }, // Phoenix
  { lat: 39.9526, lon: -75.1652 }, // Philadelphia
  { lat: 32.7767, lon: -96.797 }, // Dallas
  { lat: 37.7749, lon: -122.4194 }, // San Francisco
  { lat: 47.6062, lon: -122.3321 }, // Seattle
  { lat: 25.7617, lon: -80.1918 }, // Miami
  { lat: 39.7392, lon: -104.9903 }, // Denver
  { lat: 44.9778, lon: -93.265 }, // Minneapolis
];

const DISCOVER_RADIUS_MI = 30;
const PER_METRO_LIMIT = 15;
const METROS_TO_TRY = 4;

const pickRandom = <T,>(items: T[], count: number): T[] => {
  const pool = [...items];
  const picked: T[] = [];
  while (pool.length && picked.length < count) {
    const i = Math.floor(Math.random() * pool.length);
    picked.push(pool.splice(i, 1)[0]);
  }
  return picked;
};

/**
 * Fetches a small, randomized sample of community reports from a few
 * random metros, for display before we have any real location. Best-effort:
 * a metro that errors or has nothing is just skipped.
 */
export async function fetchDiscoverSamples(api: SyncApi, token: string, count = 6): Promise<PriceData[]> {
  const metros = pickRandom(DISCOVER_METROS, METROS_TO_TRY);
  const results = await Promise.allSettled(
    metros.map((point) =>
      api.pull(token, { since: 0, lat: point.lat, lon: point.lon, radiusMi: DISCOVER_RADIUS_MI, limit: PER_METRO_LIMIT }),
    ),
  );

  const reports = results.flatMap((r) => (r.status === 'fulfilled' ? r.value.reports : []));
  const active = reports.filter((r) => r.status === 'active');
  const byId = new Map(active.map((r) => [r.id, r]));
  return pickRandom([...byId.values()], count).map(communityToPriceData);
}
