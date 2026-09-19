import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database as SqliteDatabase } from 'better-sqlite3';
import { createApp } from '../app.js';
import { runMigrations } from '../db/migrate.js';
import type { AppDb } from '../db/client.js';
import type { Mailer } from '../lib/mail.js';

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

describe('report voting routes', () => {
  let db: AppDb;
  let sqlite: SqliteDatabase;
  let mailer: FakeMailer;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    ({ db, sqlite } = runMigrations(':memory:'));
    mailer = new FakeMailer();
    app = createApp({ db, corsOrigins: ['http://localhost:5173'], mailer });
  });

  afterEach(() => {
    sqlite.close();
  });

  const json = (res: Response): Promise<Record<string, any>> => res.json() as Promise<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any

  const signIn = async (email: string): Promise<string> => {
    await app.request('/api/auth/request-code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
    const res = await app.request('/api/auth/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, code: mailer.lastCode() }) });
    return (await json(res)).sessionToken as string;
  };

  const pushOne = async (token: string, overrides: Record<string, unknown> = {}) => {
    const res = await app.request('/api/sync/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        reports: [{
          id: 'r1', itemName: 'Milk', brand: '', tags: [], quantity: 1, quantityUnits: 'gallon',
          price: '3.49', store: 'Kroger @ 9150 North Tarrant Parkway',
          latitude: KROGER_LAT, longitude: KROGER_LON, observedDate: '2026-09-01', updatedAt: '2026-09-01T12:00:00.000Z',
          ...overrides,
        }],
      }),
    });
    return (await json(res)).results[0];
  };

  it('confirms a report and reflects the count on the next pull', async () => {
    const author = await signIn('author@example.com');
    await pushOne(author);
    const voter = await signIn('voter@example.com');

    const res = await app.request('/api/reports/r1/confirm', { method: 'POST', headers: { Authorization: `Bearer ${voter}` } });
    expect(res.status).toBe(200);
    expect((await json(res)).confirmCount).toBe(1);

    const pull = await json(
      await app.request(`/api/sync/pull?since=0&lat=${KROGER_LAT}&lon=${KROGER_LON}&radiusMi=10`, { headers: { Authorization: `Bearer ${voter}` } }),
    );
    expect(pull.reports[0].confirmCount).toBe(1);
    expect(pull.reports[0].myVote).toBe('confirm');
  });

  it('rejects confirming your own report with 403', async () => {
    const author = await signIn('author@example.com');
    await pushOne(author);
    const res = await app.request('/api/reports/r1/confirm', { method: 'POST', headers: { Authorization: `Bearer ${author}` } });
    expect(res.status).toBe(403);
  });

  it('requires a reason to flag, and rejects an invalid one', async () => {
    const author = await signIn('author@example.com');
    await pushOne(author);
    const voter = await signIn('voter@example.com');
    const noReason = await app.request('/api/reports/r1/flag', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${voter}` }, body: '{}' });
    expect(noReason.status).toBe(400);
    const badReason = await app.request('/api/reports/r1/flag', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${voter}` }, body: JSON.stringify({ reason: 'nonsense' }) });
    expect(badReason.status).toBe(400);
  });

  it('two fresh-trust flags (weight 1.0 total) do not cross the 1.5 hide threshold', async () => {
    // Every new account starts at trust 0.5 (plan section 9.2), so this
    // exercises the route wiring for flag weight without needing to
    // manufacture a trusted account through HTTP; the threshold math
    // itself is covered exhaustively in services/__tests__/votes.test.ts.
    const author = await signIn('author@example.com');
    await pushOne(author);
    const a = await signIn('a@example.com');
    const b = await signIn('b@example.com');

    await app.request('/api/reports/r1/flag', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${a}` }, body: JSON.stringify({ reason: 'wrong_price' }) });
    const res = await app.request('/api/reports/r1/flag', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${b}` }, body: JSON.stringify({ reason: 'wrong_price' }) });
    const flagState = await json(res);
    expect(flagState.flagWeight).toBeCloseTo(1.0);
    expect(flagState.status).toBe('active');

    // Pull still includes the report with its true (still-active) status;
    // pull never excludes a report just because it was flagged (plan
    // section 7: hidden/deleted state changes are sent, not omitted).
    const pull = await json(await app.request(`/api/sync/pull?since=0&lat=${KROGER_LAT}&lon=${KROGER_LON}&radiusMi=10`, { headers: { Authorization: `Bearer ${a}` } }));
    expect(pull.reports).toHaveLength(1);
    expect(pull.reports[0].status).toBe('active');
  });

  it('withdraws a vote via DELETE', async () => {
    const author = await signIn('author@example.com');
    await pushOne(author);
    const voter = await signIn('voter@example.com');
    await app.request('/api/reports/r1/confirm', { method: 'POST', headers: { Authorization: `Bearer ${voter}` } });
    const res = await app.request('/api/reports/r1/vote', { method: 'DELETE', headers: { Authorization: `Bearer ${voter}` } });
    expect((await json(res)).myVote).toBeNull();
  });

  it('requires sign-in, not just a device token, to vote', async () => {
    const author = await signIn('author@example.com');
    await pushOne(author);
    const deviceRes = await app.request('/api/devices/register', { method: 'POST' });
    const { deviceToken } = await json(deviceRes);
    const res = await app.request('/api/reports/r1/confirm', { method: 'POST', headers: { Authorization: `Bearer ${deviceToken}` } });
    expect(res.status).toBe(401);
  });
});
