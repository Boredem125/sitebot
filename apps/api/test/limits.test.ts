import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { isOriginAllowed, monthlyUsage, rateLimit, recordUsageStatement } from '../src/limits';
import { seedSite } from './helpers';

describe('isOriginAllowed', () => {
  const domains = ['example.com'];

  it('allows the domain and its subdomains', () => {
    expect(isOriginAllowed('https://example.com', domains)).toBe(true);
    expect(isOriginAllowed('https://www.example.com', domains)).toBe(true);
    expect(isOriginAllowed('http://EXAMPLE.com:8080', domains)).toBe(true);
  });

  it('rejects other hosts, lookalikes, and missing or malformed origins', () => {
    expect(isOriginAllowed('https://evil.com', domains)).toBe(false);
    expect(isOriginAllowed('https://notexample.com', domains)).toBe(false);
    expect(isOriginAllowed('https://example.com.evil.com', domains)).toBe(false);
    expect(isOriginAllowed(null, domains)).toBe(false);
    expect(isOriginAllowed('null', domains)).toBe(false);
    expect(isOriginAllowed('file://example.com', domains)).toBe(false);
    expect(isOriginAllowed('https://example.com', [])).toBe(false);
    expect(isOriginAllowed('https://example.com', [''])).toBe(false);
  });
});

describe('rateLimit', () => {
  it('allows up to the limit, then blocks until the window ends', async () => {
    const now = 1_000_000_000_000;
    for (let i = 0; i < 3; i++) {
      expect((await rateLimit(env.DB, 'k1', 3, 60, now)).ok).toBe(true);
    }
    const blocked = await rateLimit(env.DB, 'k1', 3, 60, now);
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfter).toBeGreaterThan(0);
    expect(blocked.retryAfter).toBeLessThanOrEqual(60);

    expect((await rateLimit(env.DB, 'k1', 3, 60, now + 60_000)).ok).toBe(true);
  });

  it('counts keys separately', async () => {
    const now = 1_000_000_000_000;
    expect((await rateLimit(env.DB, 'a', 1, 60, now)).ok).toBe(true);
    expect((await rateLimit(env.DB, 'b', 1, 60, now)).ok).toBe(true);
    expect((await rateLimit(env.DB, 'a', 1, 60, now)).ok).toBe(false);
  });
});

describe('monthly usage', () => {
  it('sums the current month only, per site', async () => {
    const a = await seedSite(env.DB);
    const b = await seedSite(env.DB);
    const oct = Date.UTC(2026, 9, 11);
    const sep = Date.UTC(2026, 8, 30);
    const usage = { promptTokens: 100, completionTokens: 20, cachedTokens: 50 };
    await env.DB.batch([
      recordUsageStatement(env.DB, a.siteId, usage, oct),
      recordUsageStatement(env.DB, a.siteId, usage, oct),
      recordUsageStatement(env.DB, a.siteId, usage, sep),
      recordUsageStatement(env.DB, b.siteId, usage, oct),
    ]);

    expect(await monthlyUsage(env.DB, a.siteId, oct)).toEqual({
      month: '2026-10',
      messages: 2,
      promptTokens: 200,
      completionTokens: 40,
      cachedTokens: 100,
    });
    expect((await monthlyUsage(env.DB, b.siteId, oct)).messages).toBe(1);
  });
});
