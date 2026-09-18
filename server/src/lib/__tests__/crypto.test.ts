import { describe, it, expect } from 'vitest';
import { randomToken, sha256Hex, randomCode, hashCode, verifyCode } from '../crypto.js';

describe('randomToken', () => {
  it('produces distinct, fixed-length hex strings', () => {
    const a = randomToken();
    const b = randomToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('sha256Hex', () => {
  it('is deterministic and sensitive to input', () => {
    expect(sha256Hex('abc')).toBe(sha256Hex('abc'));
    expect(sha256Hex('abc')).not.toBe(sha256Hex('abd'));
  });
});

describe('randomCode', () => {
  it('is always 6 digits, zero-padded', () => {
    for (let i = 0; i < 50; i++) {
      expect(randomCode()).toMatch(/^\d{6}$/);
    }
  });
});

describe('hashCode / verifyCode', () => {
  it('round-trips the correct code and rejects a wrong one', () => {
    const stored = hashCode('123456');
    expect(verifyCode('123456', stored)).toBe(true);
    expect(verifyCode('654321', stored)).toBe(false);
  });

  it('produces a different hash each time (random salt)', () => {
    expect(hashCode('123456')).not.toBe(hashCode('123456'));
  });

  it('rejects malformed stored values instead of throwing', () => {
    expect(verifyCode('123456', 'not-a-valid-stored-value')).toBe(false);
    expect(verifyCode('123456', '')).toBe(false);
  });
});
