import { and, desc, eq, isNull } from 'drizzle-orm';
import type { AppDb } from '../db/client.js';
import { authCodes, sessions, users } from '../db/schema.js';
import { newId } from '../lib/ids.js';
import { hashCode, randomCode, randomToken, sha256Hex, verifyCode as verifyCodeHash } from '../lib/crypto.js';
import type { Mailer } from '../lib/mail.js';

export interface AuthConfig {
  codeTtlMinutes: number;
  codeMaxAttempts: number;
  codeCooldownSeconds: number;
  sessionTtlDays: number;
}

/** Matches plan section 6.1: 10-minute expiry, 5 attempts, 90-day sliding session. */
export const defaultAuthConfig: AuthConfig = {
  codeTtlMinutes: 10,
  codeMaxAttempts: 5,
  codeCooldownSeconds: 60,
  sessionTtlDays: 90,
};

export class AuthCooldownError extends Error {}
export class AuthInvalidCodeError extends Error {}
export class AuthCodeExpiredError extends Error {}
export class AuthTooManyAttemptsError extends Error {}

const normalizeEmail = (email: string): string => email.trim().toLowerCase();

const latestPendingCode = (db: AppDb, email: string) =>
  db
    .select()
    .from(authCodes)
    .where(and(eq(authCodes.email, email), isNull(authCodes.consumedAt)))
    .orderBy(desc(authCodes.createdAt))
    .limit(1)
    .all()[0];

/** Generates a code, stores its hash, and emails it. Throws AuthCooldownError if one was just sent. */
export async function requestCode(
  db: AppDb,
  mailer: Mailer,
  email: string,
  config: AuthConfig = defaultAuthConfig,
  now: () => Date = () => new Date(),
): Promise<void> {
  const normalized = normalizeEmail(email);
  const nowMs = now().getTime();

  const recent = latestPendingCode(db, normalized);
  if (recent && nowMs - Date.parse(recent.createdAt) < config.codeCooldownSeconds * 1000) {
    throw new AuthCooldownError('A code was already sent recently. Wait a bit before requesting another.');
  }

  const code = randomCode();
  const expiresAt = new Date(nowMs + config.codeTtlMinutes * 60_000).toISOString();

  db.insert(authCodes)
    .values({ id: newId(), email: normalized, codeHash: hashCode(code), expiresAt })
    .run();

  await mailer.send(
    normalized,
    'Your GrocerEZ sign-in code',
    `Your code is ${code}. It expires in ${config.codeTtlMinutes} minutes.`,
  );
}

export interface VerifiedSession {
  userId: string;
  sessionToken: string;
  expiresAt: string;
}

/** Checks the code, creates the user on first sign-in, and issues a session token. */
export async function verifyCode(
  db: AppDb,
  email: string,
  code: string,
  config: AuthConfig = defaultAuthConfig,
  now: () => Date = () => new Date(),
): Promise<VerifiedSession> {
  const normalized = normalizeEmail(email);
  const nowMs = now().getTime();

  const pending = latestPendingCode(db, normalized);
  if (!pending) throw new AuthInvalidCodeError('Request a code before verifying.');
  if (pending.attempts >= config.codeMaxAttempts) {
    throw new AuthTooManyAttemptsError('Too many attempts. Request a new code.');
  }
  if (Date.parse(pending.expiresAt) < nowMs) throw new AuthCodeExpiredError('This code has expired.');

  if (!verifyCodeHash(code.trim(), pending.codeHash)) {
    db.update(authCodes).set({ attempts: pending.attempts + 1 }).where(eq(authCodes.id, pending.id)).run();
    throw new AuthInvalidCodeError('Incorrect code.');
  }

  db.update(authCodes).set({ consumedAt: new Date(nowMs).toISOString() }).where(eq(authCodes.id, pending.id)).run();

  let user = db.select().from(users).where(eq(users.email, normalized)).all()[0];
  if (!user) {
    const id = newId();
    db.insert(users).values({ id, email: normalized }).run();
    user = db.select().from(users).where(eq(users.id, id)).all()[0];
  }
  if (!user) throw new Error('Failed to create or load user.');

  const token = randomToken();
  const expiresAt = new Date(nowMs + config.sessionTtlDays * 86_400_000).toISOString();
  db.insert(sessions)
    .values({ id: newId(), userId: user.id, tokenHash: sha256Hex(token), expiresAt })
    .run();

  return { userId: user.id, sessionToken: token, expiresAt };
}

export function resolveSession(
  db: AppDb,
  token: string,
  now: () => Date = () => new Date(),
): { userId: string; sessionId: string } | null {
  const session = db.select().from(sessions).where(eq(sessions.tokenHash, sha256Hex(token))).all()[0];
  if (!session) return null;
  if (Date.parse(session.expiresAt) < now().getTime()) return null;
  db.update(sessions).set({ lastSeenAt: now().toISOString() }).where(eq(sessions.id, session.id)).run();
  return { userId: session.userId, sessionId: session.id };
}

export function signOutSession(db: AppDb, sessionId: string): void {
  db.delete(sessions).where(eq(sessions.id, sessionId)).run();
}
