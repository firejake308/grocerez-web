import { Hono } from 'hono';
import type { AppDb } from '../db/client.js';
import { registerDevice } from '../services/devices.js';

export function deviceRoutes(db: AppDb) {
  const router = new Hono();

  router.post('/register', (c) => {
    const { deviceToken } = registerDevice(db);
    return c.json({ deviceToken });
  });

  return router;
}
