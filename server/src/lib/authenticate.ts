import type { Context, Next } from 'hono';
import type { AppDb } from '../db/client.js';
import { resolveSession } from '../services/auth.js';
import { resolveDevice } from '../services/devices.js';

export type AuthResult =
  | { kind: 'session'; userId: string; sessionId: string }
  | { kind: 'device'; deviceId: string; userId: string | null };

/** Hono context variables set by requireAuth/requireUser. */
export type AppEnv = { Variables: { auth: AuthResult } };

/** Resolves a bearer token to a session or a device, whichever it matches. Session is checked first. */
export function authenticate(db: AppDb, authHeader: string | undefined): AuthResult | null {
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice('Bearer '.length).trim();
  if (!token) return null;

  const session = resolveSession(db, token);
  if (session) return { kind: 'session', userId: session.userId, sessionId: session.sessionId };

  const device = resolveDevice(db, token);
  if (device) return { kind: 'device', deviceId: device.deviceId, userId: device.userId };

  return null;
}

/** Requires either a signed-in session or a registered device token. */
export function requireAuth(db: AppDb) {
  return async (c: Context<AppEnv>, next: Next) => {
    const auth = authenticate(db, c.req.header('Authorization'));
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    c.set('auth', auth);
    await next();
  };
}

/** Requires a signed-in user specifically -- a device token alone is not enough. */
export function requireUser(db: AppDb) {
  return async (c: Context<AppEnv>, next: Next) => {
    const auth = authenticate(db, c.req.header('Authorization'));
    if (!auth || auth.kind !== 'session') return c.json({ error: 'Sign-in required' }, 401);
    c.set('auth', auth);
    await next();
  };
}
