import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createApp } from '../app.js';
import { runMigrations } from '../db/migrate.js';
import type { AppDb } from '../db/client.js';
import type { Database as SqliteDatabase } from 'better-sqlite3';

describe('createApp', () => {
  let db: AppDb;
  let sqlite: SqliteDatabase;

  beforeEach(() => {
    ({ db, sqlite } = runMigrations(':memory:'));
  });

  afterEach(() => {
    sqlite.close();
  });

  it('answers /healthz', async () => {
    const app = createApp({ db, corsOrigins: ['http://localhost:5173'] });
    const res = await app.request('/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('confirms the database is reachable on /api/db-check', async () => {
    const app = createApp({ db, corsOrigins: ['http://localhost:5173'] });
    const res = await app.request('/api/db-check');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('applies CORS to the configured origins', async () => {
    const app = createApp({ db, corsOrigins: ['https://grocerez.example'] });
    const res = await app.request('/healthz', {
      headers: { Origin: 'https://grocerez.example' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBe('https://grocerez.example');
  });
});
