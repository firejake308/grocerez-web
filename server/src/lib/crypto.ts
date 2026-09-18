import { randomBytes, createHash, scryptSync, timingSafeEqual } from 'node:crypto';

/** A high-entropy bearer token (session or device), returned to the client once; only its hash is stored. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}

/** SHA-256 hex digest. Fine for high-entropy tokens: brute force is infeasible regardless of hash speed. */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** A 6-digit sign-in code as a zero-padded string, e.g. "004821". */
export function randomCode(): string {
  const n = randomBytes(4).readUInt32BE(0) % 1_000_000;
  return n.toString().padStart(6, '0');
}

/**
 * Low-entropy secrets (the 6-digit code) get a slow hash, since attempts and
 * expiry alone are a thinner defense than for a 256-bit token. Format is
 * "saltHex:hashHex" so no separate column is needed for the salt.
 */
export function hashCode(code: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(code, salt, 32);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyCode(code: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(code, salt, expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
