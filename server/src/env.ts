/**
 * Environment variables, read once and validated at startup. See
 * .env.example for what each one does.
 */

const optional = (name: string, fallback: string): string => process.env[name] ?? fallback;

export const env = {
  PORT: Number(optional('PORT', '8787')),
  DATABASE_PATH: optional('DATABASE_PATH', './data/grocerez.db'),
  CORS_ORIGINS: optional('CORS_ORIGINS', 'http://localhost:5173').split(',').map((s) => s.trim()).filter(Boolean),
  ADMIN_TOKEN: optional('ADMIN_TOKEN', ''),
  MAIL_PROVIDER: optional('MAIL_PROVIDER', 'console'),
  RESEND_API_KEY: optional('RESEND_API_KEY', ''),
  MAIL_FROM: optional('MAIL_FROM', 'GrocerEZ <noreply@example.com>'),
  OVERPASS_URL: optional('OVERPASS_URL', ''),
  NOMINATIM_URL: optional('NOMINATIM_URL', 'https://nominatim.openstreetmap.org'),
  /** Section 6.3.3. Off by default so seed/dev users keep seeing everything. */
  ENTITLEMENTS_ENFORCED: optional('ENTITLEMENTS_ENFORCED', 'false') === 'true',
  /** AI parse proxy (section 9.4/Phase 3). Empty means "no key configured" -- /api/parse returns mock data instead of failing. */
  OPENROUTER_API_KEY: optional('OPENROUTER_API_KEY', ''),
  /** Rough $/1K-token estimate for the parse proxy's daily spend cap; not exact billing, just a hard stop. */
  OPENROUTER_CENTS_PER_1K_TOKENS: Number(optional('OPENROUTER_CENTS_PER_1K_TOKENS', '0.2')),
  PARSE_DAILY_BUDGET_CENTS: Number(optional('PARSE_DAILY_BUDGET_CENTS', '500')),
  /** Section 9.5-style Stripe secrets. Empty disables /api/billing/* (503), same pattern as ADMIN_TOKEN. */
  STRIPE_SECRET: optional('STRIPE_SECRET', ''),
  STRIPE_WEBHOOK_SECRET: optional('STRIPE_WEBHOOK_SECRET', ''),
  STRIPE_PRICE_ID: optional('STRIPE_PRICE_ID', ''),
  /** Where the subscribe checkout session sends the browser back to. */
  APP_URL: optional('APP_URL', 'http://localhost:5173'),
  /** Photo evidence (Phase 3). Downscaled price-tag photos, keyed by report id. */
  PHOTO_DIR: optional('PHOTO_DIR', './data/photos'),
} as const;
