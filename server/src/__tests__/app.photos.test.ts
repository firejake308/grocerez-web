import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import type { Database as SqliteDatabase } from 'better-sqlite3';
import { createApp } from '../app.js';
import { runMigrations } from '../db/migrate.js';
import type { AppDb } from '../db/client.js';
import type { Mailer } from '../lib/mail.js';

const json = (res: Response): Promise<Record<string, any>> => res.json() as Promise<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any

const KROGER_LAT = 32.9019798;
const KROGER_LON = -97.1889734;

class FakeMailer implements Mailer {
  sent: string[] = [];
  async send(_to: string, _subject: string, text: string): Promise<void> {
    this.sent.push(text);
  }
  lastCode(): string {
    return this.sent.at(-1)!.match(/\d{6}/)![0];
  }
}

describe('GET /api/reports/:id/photo', () => {
  let db: AppDb;
  let sqlite: SqliteDatabase;
  let mailer: FakeMailer;
  let photoDir: string;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    ({ db, sqlite } = runMigrations(':memory:'));
    mailer = new FakeMailer();
    photoDir = `/tmp/grocerez-test-photos-app-${Date.now()}-${Math.random()}`;
    app = createApp({ db, corsOrigins: ['http://localhost:5173'], mailer, adminToken: 'secret', parse: { apiKey: '', centsPer1kTokens: 0.2, dailyBudgetCents: 500, photoDir } });
  });

  afterEach(async () => {
    sqlite.close();
    await fs.rm(photoDir, { recursive: true, force: true });
  });

  const signIn = async (email: string): Promise<string> => {
    await app.request('/api/auth/request-code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
    const res = await app.request('/api/auth/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, code: mailer.lastCode() }) });
    return (await json(res)).sessionToken as string;
  };

  const TINY_JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=';

  /** Signs in, pushes a report, and calls /api/parse against that same id so a photo gets saved for it. */
  const seedReportWithPhoto = async (email: string): Promise<{ token: string; reportId: string }> => {
    const token = await signIn(email);
    const reportId = `report-${Math.random()}`;
    await app.request('/api/sync/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        reports: [{
          id: reportId, itemName: 'Milk', brand: '', tags: [], quantity: 1, quantityUnits: 'gallon',
          price: '3.49', store: 'Kroger', latitude: KROGER_LAT, longitude: KROGER_LON,
          observedDate: '2026-06-01', updatedAt: '2026-06-01T00:00:00.000Z',
        }],
      }),
    });
    await app.request('/api/parse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ priceImage: TINY_JPEG, productImage: TINY_JPEG, reportId }),
    });
    await new Promise((r) => setTimeout(r, 20)); // photo save is fire-and-forget
    return { token, reportId };
  };

  it('lets the report author fetch their own photo', async () => {
    const { token, reportId } = await seedReportWithPhoto('shopper@example.com');
    const res = await app.request(`/api/reports/${reportId}/photo`, { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/jpeg');
  });

  it('denies a stranger', async () => {
    const { reportId } = await seedReportWithPhoto('shopper@example.com');
    const strangerToken = await signIn('stranger@example.com');
    const res = await app.request(`/api/reports/${reportId}/photo`, { headers: { Authorization: `Bearer ${strangerToken}` } });
    expect(res.status).toBe(404);
  });

  it('lets an admin fetch any photo via the shared admin token', async () => {
    const { reportId } = await seedReportWithPhoto('shopper@example.com');
    const res = await app.request(`/api/reports/${reportId}/photo`, { headers: { Authorization: 'Bearer secret' } });
    expect(res.status).toBe(200);
  });

  it('404s for a report with no photo evidence', async () => {
    const token = await signIn('shopper@example.com');
    const res = await app.request('/api/reports/never-scanned/photo', { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(404);
  });

  it('404s with no credentials at all', async () => {
    const { reportId } = await seedReportWithPhoto('shopper@example.com');
    const res = await app.request(`/api/reports/${reportId}/photo`);
    expect(res.status).toBe(404);
  });
});
