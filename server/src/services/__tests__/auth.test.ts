import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import type { Database as SqliteDatabase } from 'better-sqlite3';
import { runMigrations } from '../../db/migrate.js';
import type { AppDb } from '../../db/client.js';
import type { Mailer } from '../../lib/mail.js';
import {
  AuthCodeExpiredError,
  AuthCooldownError,
  AuthInvalidCodeError,
  AuthTooManyAttemptsError,
  requestCode,
  resolveSession,
  signOutSession,
  verifyCode,
} from '../auth.js';

class FakeMailer implements Mailer {
  sent: { to: string; subject: string; text: string }[] = [];
  async send(to: string, subject: string, text: string): Promise<void> {
    this.sent.push({ to, subject, text });
  }
  lastCode(): string {
    const last = this.sent.at(-1);
    const match = last?.text.match(/\d{6}/);
    if (!match) throw new Error('No code was sent.');
    return match[0];
  }
}

describe('auth service', () => {
  let db: AppDb;
  let sqlite: SqliteDatabase;
  let mailer: FakeMailer;

  beforeEach(() => {
    ({ db, sqlite } = runMigrations(':memory:'));
    mailer = new FakeMailer();
  });

  afterEach(() => {
    sqlite.close();
  });

  it('emails a 6-digit code and lets that exact code verify', async () => {
    await requestCode(db, mailer, 'Shopper@Example.com');
    const code = mailer.lastCode();
    const session = await verifyCode(db, 'shopper@example.com', code);
    expect(session.userId).toBeTruthy();
    expect(session.sessionToken).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects an incorrect code without consuming the real one', async () => {
    await requestCode(db, mailer, 'a@example.com');
    const code = mailer.lastCode();
    const wrong = code === '000000' ? '111111' : '000000';
    await expect(verifyCode(db, 'a@example.com', wrong)).rejects.toBeInstanceOf(AuthInvalidCodeError);
    // The real code still works afterward.
    await expect(verifyCode(db, 'a@example.com', code)).resolves.toBeTruthy();
  });

  it('locks out after too many wrong attempts', async () => {
    await requestCode(db, mailer, 'b@example.com');
    const code = mailer.lastCode();
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) {
      await expect(verifyCode(db, 'b@example.com', wrong)).rejects.toBeInstanceOf(AuthInvalidCodeError);
    }
    // Even the correct code is now refused until a new one is requested.
    await expect(verifyCode(db, 'b@example.com', code)).rejects.toBeInstanceOf(AuthTooManyAttemptsError);
  });

  it('rejects an expired code', async () => {
    const start = new Date('2026-01-01T00:00:00.000Z');
    await requestCode(db, mailer, 'c@example.com', undefined, () => start);
    const code = mailer.lastCode();
    const later = () => new Date(start.getTime() + 11 * 60_000);
    await expect(verifyCode(db, 'c@example.com', code, undefined, later)).rejects.toBeInstanceOf(AuthCodeExpiredError);
  });

  it('enforces a cooldown between code requests for the same email', async () => {
    await requestCode(db, mailer, 'd@example.com');
    await expect(requestCode(db, mailer, 'd@example.com')).rejects.toBeInstanceOf(AuthCooldownError);
    expect(mailer.sent).toHaveLength(1);
  });

  it('normalizes email case so sign-in works regardless of how it was typed', async () => {
    await requestCode(db, mailer, 'MixedCase@Example.com');
    const code = mailer.lastCode();
    const session = await verifyCode(db, 'mixedcase@example.com', code);
    expect(session.userId).toBeTruthy();
  });

  it('reuses the same user across separate sign-in cycles', async () => {
    await requestCode(db, mailer, 'e@example.com');
    const first = await verifyCode(db, 'e@example.com', mailer.lastCode());

    await requestCode(db, mailer, 'e@example.com', undefined, () => new Date(Date.now() + 120_000));
    const second = await verifyCode(
      db,
      'e@example.com',
      mailer.lastCode(),
      undefined,
      () => new Date(Date.now() + 120_000),
    );

    expect(second.userId).toBe(first.userId);
    expect(second.sessionToken).not.toBe(first.sessionToken);
  });

  it('resolves a live session and rejects one that has been signed out', async () => {
    await requestCode(db, mailer, 'f@example.com');
    const { sessionToken } = await verifyCode(db, 'f@example.com', mailer.lastCode());

    const resolved = resolveSession(db, sessionToken);
    expect(resolved?.userId).toBeTruthy();

    signOutSession(db, resolved!.sessionId);
    expect(resolveSession(db, sessionToken)).toBeNull();
  });

  it('rejects an unknown token', () => {
    expect(resolveSession(db, 'not-a-real-token')).toBeNull();
  });
});
