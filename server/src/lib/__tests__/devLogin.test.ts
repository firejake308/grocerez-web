import { describe, it, expect } from 'vitest';
import { assertDevLoginSafe, isTestEmail } from '../devLogin.js';

describe('isTestEmail', () => {
  it('matches the reserved example.test domain, ignoring case and surrounding space', () => {
    expect(isTestEmail('me@example.test')).toBe(true);
    expect(isTestEmail('  Me@Example.TEST ')).toBe(true);
    expect(isTestEmail('a.b+c@example.test')).toBe(true);
  });

  it('rejects real addresses and every lookalike', () => {
    for (const e of [
      'me@gmail.com',
      'me@example.com',
      'me@sub.example.test',
      'me@notexample.test',
      'me@example.test.evil.com',
      'example.test@gmail.com',
      'me@example.testing',
      'me@evil.com?@example.test.x',
      '',
    ]) {
      expect(isTestEmail(e), e).toBe(false);
    }
  });
});

describe('assertDevLoginSafe', () => {
  const ok = { code: '123456', mailProvider: 'console', stripeApiKey: 'sk_test_abc' };

  it('does nothing when the shortcut is not configured, whatever else is set', () => {
    expect(() => assertDevLoginSafe({ code: '', mailProvider: 'resend', stripeApiKey: 'sk_live_abc' })).not.toThrow();
  });

  it('allows a 6-digit code with console mail and test or no Stripe keys', () => {
    expect(() => assertDevLoginSafe(ok)).not.toThrow();
    expect(() => assertDevLoginSafe({ ...ok, stripeApiKey: '' })).not.toThrow();
    expect(() => assertDevLoginSafe({ ...ok, stripeApiKey: 'rk_test_abc' })).not.toThrow();
  });

  it('refuses a code that is not exactly 6 digits', () => {
    for (const code of ['12345', '1234567', 'abcdef', '12 456', '１２３４５６']) {
      expect(() => assertDevLoginSafe({ ...ok, code }), code).toThrow(/6 digits/);
    }
  });

  it('refuses to coexist with a real mail provider', () => {
    expect(() => assertDevLoginSafe({ ...ok, mailProvider: 'resend' })).toThrow(/mail provider/);
  });

  it('refuses to coexist with a live Stripe key of either kind', () => {
    expect(() => assertDevLoginSafe({ ...ok, stripeApiKey: 'sk_live_abc' })).toThrow(/live Stripe/);
    expect(() => assertDevLoginSafe({ ...ok, stripeApiKey: 'rk_live_abc' })).toThrow(/live Stripe/);
  });
});
