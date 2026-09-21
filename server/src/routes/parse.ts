import { Hono } from 'hono';
import { z } from 'zod';
import type { AppDb } from '../db/client.js';
import { requireAuth, type AppEnv } from '../lib/authenticate.js';
import { consumeRateLimit, DAY_MS, LIMITS } from '../services/rateLimit.js';
import { dailySpendCents, parseImages, ParseError } from '../services/parse.js';
import { savePhoto } from '../services/photos.js';

const parseSchema = z.object({
  priceImage: z.string().min(1),
  productImage: z.string().min(1),
  /** The report id the client plans to save with (section 8.4-style forward id), so the photo can be filed under it. Optional: older clients or a cancelled scan just skip photo storage. */
  reportId: z.string().min(1).optional(),
});

export interface ParseRouteDeps {
  apiKey: string;
  centsPer1kTokens: number;
  dailyBudgetCents: number;
  photoDir: string;
}

/**
 * AI parse proxy (Phase 3): moves the OpenRouter call server-side so the
 * key never ships in the client bundle. Decision 9 (plan section 15):
 * anonymous scanning stays allowed, so this accepts a device token, not
 * just a session -- capped per caller per day plus a server-wide daily
 * spend cap that hard-stops everyone once hit.
 */
export function parseRoutes(db: AppDb, deps: ParseRouteDeps, now: () => Date = () => new Date()) {
  const router = new Hono<AppEnv>();
  router.use('*', requireAuth(db));

  router.post('/', async (c) => {
    const auth = c.get('auth');
    const callerKey = auth.kind === 'session' ? `parse:user:${auth.userId}` : `parse:device:${auth.deviceId}`;
    if (!consumeRateLimit(db, callerKey, LIMITS.parsePerCallerDay, now, DAY_MS)) {
      return c.json({ error: 'Too many photo scans today. Try again tomorrow.' }, 429);
    }
    if (dailySpendCents(db, now) >= deps.dailyBudgetCents) {
      return c.json({ error: 'The AI parsing budget for today has been reached. Try again tomorrow, or enter the details by hand.' }, 429);
    }

    const body = parseSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'priceImage and productImage are required.' }, 400);

    try {
      const fields = await parseImages(db, deps.apiKey, deps.centsPer1kTokens, body.data.priceImage, body.data.productImage, now);
      if (body.data.reportId) {
        // Best-effort: a photo write failure should never block returning the parsed fields.
        savePhoto(db, deps.photoDir, body.data.reportId, body.data.priceImage, now).catch((err) => {
          console.warn('Failed to save photo evidence:', err instanceof Error ? err.message : err);
        });
      }
      return c.json(fields);
    } catch (err) {
      if (err instanceof ParseError) return c.json({ error: err.message }, err.status as 422 | 429 | 502);
      console.error(err);
      return c.json({ error: 'Internal error' }, 500);
    }
  });

  return router;
}
