import { Hono } from 'hono';
import type { AppDb } from '../db/client.js';
import { requireAuth, type AppEnv } from '../lib/authenticate.js';
import { geocode, nearbyStores, reverseGeocode, type GeoDeps } from '../services/geo.js';

const parseLatLon = (latRaw: string | undefined, lonRaw: string | undefined): { lat: number; lon: number } | null => {
  const lat = Number(latRaw);
  const lon = Number(lonRaw);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
};

/**
 * All three endpoints require a session or device token: without that
 * they would be an open proxy to Nominatim and your Overpass box.
 */
export function geoRoutes(db: AppDb, deps: GeoDeps) {
  const router = new Hono<AppEnv>();
  router.use('*', requireAuth(db));

  router.get('/nearby-stores', async (c) => {
    const point = parseLatLon(c.req.query('lat'), c.req.query('lon'));
    if (!point) return c.json({ error: 'lat and lon are required.' }, 400);
    const results = await nearbyStores(db, deps, point.lat, point.lon);
    return c.json({ stores: results });
  });

  router.get('/reverse', async (c) => {
    const point = parseLatLon(c.req.query('lat'), c.req.query('lon'));
    if (!point) return c.json({ error: 'lat and lon are required.' }, 400);
    try {
      return c.json(await reverseGeocode(deps, point.lat, point.lon));
    } catch (err) {
      console.warn('Reverse geocode failed:', err instanceof Error ? err.message : err);
      return c.json({ error: 'Reverse geocoding is unavailable right now.' }, 502);
    }
  });

  router.get('/geocode', async (c) => {
    const q = (c.req.query('q') ?? '').trim();
    if (q.length < 2 || q.length > 200) return c.json({ error: 'q must be 2-200 characters.' }, 400);
    try {
      return c.json({ results: await geocode(deps, q) });
    } catch (err) {
      console.warn('Geocode failed:', err instanceof Error ? err.message : err);
      return c.json({ error: 'Geocoding is unavailable right now.' }, 502);
    }
  });

  return router;
}
