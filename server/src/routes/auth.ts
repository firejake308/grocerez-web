import { Hono } from 'hono';
import { z } from 'zod';
import type { AppDb } from '../db/client.js';
import type { Mailer } from '../lib/mail.js';
import { requireUser, type AppEnv } from '../lib/authenticate.js';
import {
  AuthCodeExpiredError,
  AuthCooldownError,
  AuthInvalidCodeError,
  AuthTooManyAttemptsError,
  requestCode,
  signOutSession,
  verifyCode,
} from '../services/auth.js';

const emailSchema = z.string().trim().toLowerCase().email().max(320);
const codeSchema = z.string().trim().regex(/^\d{6}$/, 'Codes are 6 digits');

export interface AuthRoutesDeps {
  db: AppDb;
  mailer: Mailer;
}

export function authRoutes({ db, mailer }: AuthRoutesDeps) {
  const router = new Hono<AppEnv>();

  router.post('/request-code', async (c) => {
    const body = await c.req.json().catch(() => null);
    const email = emailSchema.safeParse(body?.email);
    if (!email.success) return c.json({ error: 'A valid email is required.' }, 400);

    try {
      await requestCode(db, mailer, email.data);
    } catch (err) {
      if (err instanceof AuthCooldownError) return c.json({ error: err.message }, 429);
      throw err;
    }
    return c.json({ ok: true });
  });

  router.post('/verify', async (c) => {
    const body = await c.req.json().catch(() => null);
    const email = emailSchema.safeParse(body?.email);
    const code = codeSchema.safeParse(body?.code);
    if (!email.success || !code.success) {
      return c.json({ error: 'A valid email and 6-digit code are required.' }, 400);
    }

    try {
      const result = await verifyCode(db, email.data, code.data);
      return c.json(result);
    } catch (err) {
      if (err instanceof AuthInvalidCodeError || err instanceof AuthCodeExpiredError) {
        return c.json({ error: err.message }, 401);
      }
      if (err instanceof AuthTooManyAttemptsError) return c.json({ error: err.message }, 429);
      throw err;
    }
  });

  router.post('/signout', requireUser(db), (c) => {
    const auth = c.get('auth');
    if (auth.kind === 'session') signOutSession(db, auth.sessionId);
    return c.json({ ok: true });
  });

  return router;
}
