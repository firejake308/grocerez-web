import { eq } from 'drizzle-orm';
import type { AppDb } from '../db/client.js';
import { devices } from '../db/schema.js';
import { newId } from '../lib/ids.js';
import { randomToken, sha256Hex } from '../lib/crypto.js';

export function registerDevice(db: AppDb): { deviceToken: string } {
  const token = randomToken();
  db.insert(devices).values({ id: newId(), tokenHash: sha256Hex(token) }).run();
  return { deviceToken: token };
}

export function resolveDevice(
  db: AppDb,
  token: string,
  now: () => Date = () => new Date(),
): { deviceId: string; userId: string | null } | null {
  const device = db.select().from(devices).where(eq(devices.tokenHash, sha256Hex(token))).all()[0];
  if (!device) return null;
  db.update(devices).set({ lastSeenAt: now().toISOString() }).where(eq(devices.id, device.id)).run();
  return { deviceId: device.id, userId: device.userId };
}

/** Called after sign-in so a device that scanned anonymously keeps its history linked to the account. */
export function linkDeviceToUser(db: AppDb, deviceId: string, userId: string): void {
  db.update(devices).set({ userId }).where(eq(devices.id, deviceId)).run();
}
