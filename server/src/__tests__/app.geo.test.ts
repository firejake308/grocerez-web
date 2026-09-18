import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database as SqliteDatabase } from 'better-sqlite3';
import { createApp } from '../app.js';
import { runMigrations } from '../db/migrate.js';
import type { AppDb } from '../db/client.js';
import { _resetGeoCachesForTests } from '../services/geo.js';
import { resolveStore } from '../services/stores.js';

// Kroger @ 9150 North Tarrant Parkway, from the real export.
const KROGER = { lat: 32.9019798, lon: -97.1889734 };

/** Records every request and answers from a per-URL-prefix table. */
class FakeFetch {
  calls: { url: string; init?: RequestInit }[] = [];
  constructor(private answers: Record<string, unknown | (() => unknown)>) {}
  fn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    this.calls.push({ url, init });
    for (const [prefix, answer] of Object.entries(this.answers)) {
      if (url.startsWith(prefix)) {
        const value = typeof answer === 'function' ? (answer as () => unknown)() : answer;
        if (value instanceof Error) throw value;
        if (typeof value === 'number') return new Response('', { status: value });
        return new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
}

const json = (res: Response): Promise<Record<string, any>> => res.json() as Promise<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe('geo routes', () => {
  let db: AppDb;
  let sqlite: SqliteDatabase;

  beforeEach(() => {
    ({ db, sqlite } = runMigrations(':memory:'));
    _resetGeoCachesForTests();
  });

  afterEach(() => {
    sqlite.close();
  });

  const build = (fake: FakeFetch, overpassUrl = 'http://overpass.test/api/interpreter') =>
    createApp({
      db,
      corsOrigins: ['http://localhost:5173'],
      geo: { overpassUrl, nominatimUrl: 'http://nominatim.test', fetchImpl: fake.fn, nominatimMinGapMs: 0 },
    });

  const deviceToken = async (app: ReturnType<typeof createApp>) => {
    const res = await app.request('/api/devices/register', { method: 'POST' });
    return (await json(res)).deviceToken as string;
  };

  const get = (app: ReturnType<typeof createApp>, path: string, token?: string) =>
    app.request(path, { headers: token ? { Authorization: `Bearer ${token}` } : {} });

  it('requires a session or device token', async () => {
    const app = build(new FakeFetch({}));
    const res = await get(app, `/api/geo/nearby-stores?lat=${KROGER.lat}&lon=${KROGER.lon}`);
    expect(res.status).toBe(401);
  });

  it('answers nearby-stores from the stores table without calling Overpass when a store is already known there', async () => {
    resolveStore(db, { rawStore: 'Kroger @ 9150 North Tarrant Parkway', lat: KROGER.lat, lon: KROGER.lon });
    const fake = new FakeFetch({});
    const app = build(fake);
    const token = await deviceToken(app);

    const res = await get(app, `/api/geo/nearby-stores?lat=${KROGER.lat + 0.0001}&lon=${KROGER.lon}`, token);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.stores).toHaveLength(1);
    expect(body.stores[0].name).toBe('Kroger');
    expect(body.stores[0].address).toBe('9150 North Tarrant Parkway');
    expect(body.stores[0].distanceM).toBeLessThan(20);
    expect(fake.calls).toHaveLength(0);
  });

  it('falls through to Overpass for an unknown spot, records the result, and never asks again for that spot', async () => {
    const fake = new FakeFetch({
      'http://overpass.test': {
        elements: [
          { type: 'way', center: { lat: KROGER.lat, lon: KROGER.lon }, tags: { shop: 'supermarket', name: 'Kroger', 'addr:housenumber': '9150', 'addr:street': 'North Tarrant Parkway' } },
          { type: 'node', lat: KROGER.lat + 0.0003, lon: KROGER.lon + 0.001, tags: { shop: 'nutrition_supplements', name: 'GNC' } },
          { type: 'node', lat: KROGER.lat, lon: KROGER.lon, tags: { shop: 'yes' } }, // nameless: skipped
        ],
      },
    });
    const app = build(fake);
    const token = await deviceToken(app);

    const first = await json(await get(app, `/api/geo/nearby-stores?lat=${KROGER.lat}&lon=${KROGER.lon}`, token));
    expect(first.stores.map((s: { name: string }) => s.name)).toEqual(['Kroger', 'GNC']);
    expect(first.stores[0].storeId).toBeTruthy();
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].init?.method).toBe('POST');

    const second = await json(await get(app, `/api/geo/nearby-stores?lat=${KROGER.lat}&lon=${KROGER.lon}`, token));
    expect(second.stores).toHaveLength(2);
    expect(fake.calls).toHaveLength(1); // still one: answered from the table this time
  });

  it('gives the same storeId that a later push resolves to, so the client and server agree on the store', async () => {
    const fake = new FakeFetch({
      'http://overpass.test': {
        elements: [{ type: 'node', lat: KROGER.lat, lon: KROGER.lon, tags: { shop: 'supermarket', name: 'Kroger', 'addr:housenumber': '9150', 'addr:street': 'North Tarrant Parkway' } }],
      },
    });
    const app = build(fake);
    const token = await deviceToken(app);
    const body = await json(await get(app, `/api/geo/nearby-stores?lat=${KROGER.lat}&lon=${KROGER.lon}`, token));
    const viaOverpass = body.stores[0].storeId;
    const viaPush = resolveStore(db, { rawStore: 'Kroger @ 9150 North Tarrant Parkway', lat: KROGER.lat, lon: KROGER.lon });
    expect(viaPush.id).toBe(viaOverpass);
  });

  it('returns what the table knows when Overpass is down, instead of failing the request', async () => {
    const fake = new FakeFetch({ 'http://overpass.test': () => new Error('connection refused') });
    const app = build(fake);
    const token = await deviceToken(app);
    const res = await get(app, `/api/geo/nearby-stores?lat=${KROGER.lat}&lon=${KROGER.lon}`, token);
    expect(res.status).toBe(200);
    expect((await json(res)).stores).toEqual([]);
  });

  it('skips Overpass entirely when no URL is configured', async () => {
    const fake = new FakeFetch({});
    const app = build(fake, '');
    const token = await deviceToken(app);
    const res = await get(app, `/api/geo/nearby-stores?lat=${KROGER.lat}&lon=${KROGER.lon}`, token);
    expect((await json(res)).stores).toEqual([]);
    expect(fake.calls).toHaveLength(0);
  });

  it('reverse-geocodes through Nominatim with an identifying User-Agent, and caches by location', async () => {
    const fake = new FakeFetch({
      'http://nominatim.test/reverse': { address: { house_number: '9150', road: 'North Tarrant Parkway', suburb: 'North Richland Hills' } },
    });
    const app = build(fake);
    const token = await deviceToken(app);

    const first = await json(await get(app, `/api/geo/reverse?lat=${KROGER.lat}&lon=${KROGER.lon}`, token));
    expect(first).toEqual({ houseNumber: '9150', road: 'North Tarrant Parkway', suburb: 'North Richland Hills', label: '9150 North Tarrant Parkway' });
    expect((fake.calls[0].init?.headers as Record<string, string>)['User-Agent']).toBeTruthy();

    await get(app, `/api/geo/reverse?lat=${KROGER.lat + 0.00001}&lon=${KROGER.lon}`, token); // same ~11m cell
    expect(fake.calls).toHaveLength(1);
  });

  it('falls back to road, then suburb, for the reverse label', async () => {
    const fake = new FakeFetch({ 'http://nominatim.test/reverse': { address: { road: 'Presidio Vista Drive' } } });
    const app = build(fake);
    const token = await deviceToken(app);
    const body = await json(await get(app, `/api/geo/reverse?lat=32.9&lon=-97.1`, token));
    expect(body.label).toBe('Presidio Vista Drive');
    expect(body.houseNumber).toBeNull();
  });

  it('reports 502 when Nominatim fails rather than pretending there is no address', async () => {
    const fake = new FakeFetch({ 'http://nominatim.test/reverse': 503 });
    const app = build(fake);
    const token = await deviceToken(app);
    const res = await get(app, `/api/geo/reverse?lat=32.9&lon=-97.1`, token);
    expect(res.status).toBe(502);
  });

  it('geocodes a home-area search and validates the query', async () => {
    const fake = new FakeFetch({
      'http://nominatim.test/search': [
        { display_name: 'Fort Worth, Tarrant County, Texas, United States', lat: '32.7555', lon: '-97.3308' },
        { display_name: 'Fort Worth, Indiana, United States', lat: '40.1', lon: '-86.0', extra: 'ignored' },
      ],
    });
    const app = build(fake);
    const token = await deviceToken(app);

    const body = await json(await get(app, `/api/geo/geocode?q=${encodeURIComponent('Fort Worth')}`, token));
    expect(body.results).toEqual([
      { label: 'Fort Worth, Tarrant County, Texas, United States', lat: 32.7555, lon: -97.3308 },
      { label: 'Fort Worth, Indiana, United States', lat: 40.1, lon: -86.0 },
    ]);

    const tooShort = await get(app, `/api/geo/geocode?q=F`, token);
    expect(tooShort.status).toBe(400);
  });

  it('rejects malformed coordinates', async () => {
    const app = build(new FakeFetch({}));
    const token = await deviceToken(app);
    expect((await get(app, `/api/geo/nearby-stores?lat=abc&lon=1`, token)).status).toBe(400);
    expect((await get(app, `/api/geo/reverse?lat=95&lon=1`, token)).status).toBe(400);
  });
});
