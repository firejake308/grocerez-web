import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import type { Database as SqliteDatabase } from 'better-sqlite3';
import { runMigrations } from '../../db/migrate.js';
import type { AppDb } from '../../db/client.js';
import { linkDeviceToUser, registerDevice, resolveDevice } from '../devices.js';
import { requestCode, verifyCode } from '../auth.js';
import type { Mailer } from '../../lib/mail.js';

class FakeMailer implements Mailer {
  sent: string[] = [];
  async send(_to: string, _subject: string, text: string): Promise<void> {
    this.sent.push(text);
  }
  lastCode(): string {
    return this.sent.at(-1)!.match(/\d{6}/)![0];
  }
}

describe('device identity', () => {
  let db: AppDb;
  let sqlite: SqliteDatabase;

  beforeEach(() => {
    ({ db, sqlite } = runMigrations(':memory:'));
  });

  afterEach(() => {
    sqlite.close();
  });

  it('registers a device and resolves it back by its token', () => {
    const { deviceToken } = registerDevice(db);
    expect(deviceToken).toMatch(/^[0-9a-f]{64}$/);

    const resolved = resolveDevice(db, deviceToken);
    expect(resolved?.userId).toBeNull();
  });

  it('rejects an unknown device token', () => {
    expect(resolveDevice(db, 'nope')).toBeNull();
  });

  it('links a device to a user once they sign in', async () => {
    const { deviceToken } = registerDevice(db);
    const device = resolveDevice(db, deviceToken)!;

    const mailer = new FakeMailer();
    await requestCode(db, mailer, 'g@example.com');
    const { userId } = await verifyCode(db, 'g@example.com', mailer.lastCode());

    linkDeviceToUser(db, device.deviceId, userId);
    expect(resolveDevice(db, deviceToken)?.userId).toBe(userId);
  });
});
