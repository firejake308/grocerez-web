import { describe, it, expect } from 'vitest';
import { buildCorsOriginMatcher } from '../cors.js';

describe('buildCorsOriginMatcher', () => {
  const SLUG = 'imaginative-sorbet-554b69';

  it('allows an exact match from corsOrigins', () => {
    const match = buildCorsOriginMatcher(['https://grocerez.app'], '');
    expect(match('https://grocerez.app')).toBe('https://grocerez.app');
  });

  it('rejects an origin not in corsOrigins when no Netlify slug is configured', () => {
    const match = buildCorsOriginMatcher(['https://grocerez.app'], '');
    expect(match('https://deploy-preview-1--imaginative-sorbet-554b69.netlify.app')).toBeNull();
  });

  it('allows a deploy-preview URL for the configured Netlify site', () => {
    const match = buildCorsOriginMatcher(['https://grocerez.app'], SLUG);
    const origin = `https://deploy-preview-42--${SLUG}.netlify.app`;
    expect(match(origin)).toBe(origin);
  });

  it('allows a branch-deploy URL for the configured Netlify site', () => {
    const match = buildCorsOriginMatcher(['https://grocerez.app'], SLUG);
    const origin = `https://price-report-server-sync--${SLUG}.netlify.app`;
    expect(match(origin)).toBe(origin);
  });

  it('rejects a Netlify URL for a different site', () => {
    const match = buildCorsOriginMatcher(['https://grocerez.app'], SLUG);
    expect(match('https://deploy-preview-42--some-other-site.netlify.app')).toBeNull();
  });

  it('rejects a lookalike host that only ends with the expected suffix', () => {
    const match = buildCorsOriginMatcher(['https://grocerez.app'], SLUG);
    expect(match(`https://deploy-preview-42--${SLUG}.netlify.app.evil.com`)).toBeNull();
  });

  it('rejects a non-https scheme', () => {
    const match = buildCorsOriginMatcher(['https://grocerez.app'], SLUG);
    expect(match(`http://deploy-preview-42--${SLUG}.netlify.app`)).toBeNull();
  });

  it('is unaffected by an unrelated trailing slash mismatch (browsers never send one)', () => {
    const match = buildCorsOriginMatcher(['https://grocerez.app/'], '');
    // The configured entry has a trailing slash; a real browser Origin header never does.
    expect(match('https://grocerez.app')).toBeNull();
  });
});
