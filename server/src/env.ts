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
  /** Off until Phase 3 (Stripe + the free-tier job exist); see plan section 6.3.3. */
  ENTITLEMENTS_ENFORCED: optional('ENTITLEMENTS_ENFORCED', 'false') === 'true',
} as const;
