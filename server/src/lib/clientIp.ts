import type { Context } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';

/**
 * The caller's IP for per-network rate limits. Behind the Cloudflare
 * Tunnel the real address arrives in X-Forwarded-For (first hop); on a
 * direct connection it comes from the socket.
 */
export function clientIp(c: Context): string {
  const forwarded = c.req.header('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  const cf = c.req.header('cf-connecting-ip');
  if (cf) return cf.trim();
  try {
    return getConnInfo(c).remote.address ?? 'unknown';
  } catch {
    return 'unknown';
  }
}
