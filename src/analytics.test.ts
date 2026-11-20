import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Fresh module per test: `enabled` and the queue are module state.
async function load() {
  vi.resetModules();
  return import('./analytics');
}

describe('analytics', () => {
  beforeEach(() => {
    document.head.innerHTML = '';
    delete window.umami;
  });
  afterEach(() => vi.unstubAllEnvs());

  it('does nothing when not configured', async () => {
    vi.stubEnv('VITE_UMAMI_SCRIPT_URL', '');
    vi.stubEnv('VITE_UMAMI_WEBSITE_ID', '');
    const { initAnalytics, track } = await load();
    initAnalytics();
    const spy = vi.fn();
    window.umami = { track: spy };
    track('search', { results: 1 });
    expect(document.querySelector('script')).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('injects the tracker and flushes events queued before it loaded', async () => {
    vi.stubEnv('VITE_UMAMI_SCRIPT_URL', 'https://stats.example.test/script.js');
    vi.stubEnv('VITE_UMAMI_WEBSITE_ID', 'site-123');
    vi.stubEnv('VITE_UMAMI_DOMAINS', 'grocerez.app');
    const { initAnalytics, track } = await load();
    initAnalytics();

    const script = document.querySelector('script')!;
    expect(script.src).toBe('https://stats.example.test/script.js');
    expect(script.dataset.websiteId).toBe('site-123');
    expect(script.dataset.domains).toBe('grocerez.app');

    track('scan_started');
    track('search', { results: 0, locked: 2 });
    const spy = vi.fn();
    window.umami = { track: spy };
    script.onload?.(new Event('load'));
    expect(spy.mock.calls).toEqual([['scan_started', undefined], ['search', { results: 0, locked: 2 }]]);

    track('report_saved');
    expect(spy).toHaveBeenLastCalledWith('report_saved', undefined);
  });
});
