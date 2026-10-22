import { isLiveKey } from '../services/billing.js';

/**
 * Dev-only sign-in shortcut for deploy previews (see "Dev API on the VPS" in
 * README.md). When DEV_LOGIN_CODE is set, addresses at example.test -- a TLD
 * RFC 2606 reserves, so it can never be a real mailbox -- skip email and accept
 * that fixed code. Every other address signs in exactly as before.
 *
 * It is a login bypass, so it refuses to exist anywhere that matters: the
 * server will not start with it alongside live Stripe keys or a real mail
 * provider, and compose never passes it to the production container.
 */

export const TEST_EMAIL_DOMAIN = 'example.test';

export interface DevLogin {
  code: string;
}

/** Exact domain only: not subdomains, and not lookalikes such as example.test.evil.com. */
export const isTestEmail = (email: string): boolean => email.trim().toLowerCase().endsWith(`@${TEST_EMAIL_DOMAIN}`);

export function assertDevLoginSafe({ code, mailProvider, stripeApiKey }: { code: string; mailProvider: string; stripeApiKey: string }): void {
  if (!code) return;
  if (!/^\d{6}$/.test(code)) throw new Error('DEV_LOGIN_CODE must be exactly 6 digits.');
  if (mailProvider !== 'console') {
    throw new Error('Refusing to start: DEV_LOGIN_CODE is set but a real mail provider is configured. It is for the dev API only.');
  }
  if (isLiveKey(stripeApiKey)) {
    throw new Error('Refusing to start: DEV_LOGIN_CODE is set alongside a live Stripe key. It is for the dev API only.');
  }
}
