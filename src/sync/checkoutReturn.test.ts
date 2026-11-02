import { describe, it, expect, vi } from 'vitest';
import { readCheckoutReturn, waitForLevel, withoutCheckoutParam } from './checkoutReturn';

describe('readCheckoutReturn', () => {
  it('reads success and cancel', () => {
    expect(readCheckoutReturn('?checkout=success')).toBe('success');
    expect(readCheckoutReturn('?checkout=cancel')).toBe('cancel');
    expect(readCheckoutReturn('?foo=1&checkout=success')).toBe('success');
  });

  it('ignores anything else, so a hand-edited URL can not trigger a banner', () => {
    expect(readCheckoutReturn('')).toBeNull();
    expect(readCheckoutReturn('?checkout=')).toBeNull();
    expect(readCheckoutReturn('?checkout=yes')).toBeNull();
    expect(readCheckoutReturn('?checkout=SUCCESS')).toBeNull();
    expect(readCheckoutReturn('?other=success')).toBeNull();
  });
});

describe('withoutCheckoutParam', () => {
  it('removes only the checkout parameter', () => {
    expect(withoutCheckoutParam('https://grocerez.app/?checkout=success')).toBe('/');
    expect(withoutCheckoutParam('https://grocerez.app/?a=1&checkout=cancel&b=2#x')).toBe('/?a=1&b=2#x');
    expect(withoutCheckoutParam('https://grocerez.app/path')).toBe('/path');
  });
});

describe('waitForLevel', () => {
  const noSleep = () => Promise.resolve();

  it('resolves true as soon as the level arrives, without polling further', async () => {
    const getLevel = vi.fn().mockResolvedValueOnce('public').mockResolvedValueOnce('public').mockResolvedValueOnce('subscriber');
    expect(await waitForLevel(getLevel, 'subscriber', { sleep: noSleep })).toBe(true);
    expect(getLevel).toHaveBeenCalledTimes(3);
  });

  it('gives up with false after the attempt limit', async () => {
    const getLevel = vi.fn().mockResolvedValue('public');
    expect(await waitForLevel(getLevel, 'subscriber', { attempts: 4, sleep: noSleep })).toBe(false);
    expect(getLevel).toHaveBeenCalledTimes(4);
  });

  it('treats a failed lookup as "not yet" and keeps trying', async () => {
    const getLevel = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce('subscriber');
    expect(await waitForLevel(getLevel, 'subscriber', { sleep: noSleep })).toBe(true);
  });

  it('waits between attempts but not after the last one', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    await waitForLevel(async () => 'public', 'subscriber', { attempts: 3, delayMs: 1500, sleep });
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1500);
  });
});
