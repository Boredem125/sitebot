import { describe, expect, it } from 'vitest';
import { isPathAllowed, parseRobots, parseSitemap } from '../src/ingest/crawl';

describe('parseRobots', () => {
  it('uses the * group when there is none for our crawler', () => {
    const rules = parseRobots(`
      # comment
      User-agent: Googlebot
      Disallow: /google-only

      User-agent: *
      Disallow: /admin   # trailing comment
      Allow: /admin/help
      Crawl-delay: 5

      Sitemap: https://example.com/sitemap.xml
    `);
    expect(rules).toEqual({
      allow: ['/admin/help'],
      disallow: ['/admin'],
      sitemaps: ['https://example.com/sitemap.xml'],
    });
  });

  it('prefers the group for sitebotcrawler, case-insensitively', () => {
    const rules = parseRobots(
      [
        'User-agent: *',
        'Disallow: /',
        '',
        'User-Agent: SitebotCrawler',
        'Disallow: /private',
        'ALLOW: /private/open',
      ].join('\r\n'),
    );
    expect(rules.disallow).toEqual(['/private']);
    expect(rules.allow).toEqual(['/private/open']);
  });

  it('shares rules between consecutive user-agent lines and merges repeated groups', () => {
    const rules = parseRobots(`
      User-agent: otherbot
      User-agent: sitebotcrawler
      Disallow: /a

      User-agent: *
      Disallow: /star

      User-agent: sitebotcrawler
      Disallow: /b
    `);
    expect(rules.disallow).toEqual(['/a', '/b']);
  });

  it('accepts a custom user agent', () => {
    const txt = 'User-agent: mybot\nDisallow: /x\n\nUser-agent: *\nDisallow: /y';
    expect(parseRobots(txt, 'MyBot').disallow).toEqual(['/x']);
    expect(parseRobots(txt).disallow).toEqual(['/y']);
  });

  it('treats an empty Disallow as allow all, and an own group without rules as allow all', () => {
    expect(parseRobots('User-agent: *\nDisallow:').disallow).toEqual([]);
    const own = parseRobots('User-agent: *\nDisallow: /\n\nUser-agent: sitebotcrawler\nDisallow:');
    expect(own.disallow).toEqual([]);
    expect(isPathAllowed('/anything', own)).toBe(true);
  });

  it('collects sitemap lines from anywhere and survives junk', () => {
    const rules = parseRobots(
      '﻿Sitemap: https://example.com/a.xml\nnot a directive\nDisallow: /orphan\n' +
        'User-agent: googlebot\nDisallow: /g\nsitemap: /b.xml\n',
    );
    expect(rules).toEqual({ allow: [], disallow: [], sitemaps: ['https://example.com/a.xml', '/b.xml'] });
    expect(parseRobots('')).toEqual({ allow: [], disallow: [], sitemaps: [] });
  });
});

describe('isPathAllowed', () => {
  it('allows everything when there are no rules or only empty ones', () => {
    expect(isPathAllowed('/x', { allow: [], disallow: [] })).toBe(true);
    expect(isPathAllowed('/x', { allow: [], disallow: [''] })).toBe(true);
  });

  it('matches by prefix', () => {
    const rules = { allow: [], disallow: ['/private'] };
    expect(isPathAllowed('/private', rules)).toBe(false);
    expect(isPathAllowed('/private/a?b=1', rules)).toBe(false);
    expect(isPathAllowed('/privateer', rules)).toBe(false);
    expect(isPathAllowed('/public', rules)).toBe(true);
    expect(isPathAllowed('/', { allow: [], disallow: ['/'] })).toBe(false);
  });

  it('lets the longest match win and Allow win a tie', () => {
    const rules = { allow: ['/shop/public', '/tie'], disallow: ['/shop', '/shop/public/secret', '/tie'] };
    expect(isPathAllowed('/shop/cart', rules)).toBe(false);
    expect(isPathAllowed('/shop/public/list', rules)).toBe(true);
    expect(isPathAllowed('/shop/public/secret/1', rules)).toBe(false);
    expect(isPathAllowed('/tie', rules)).toBe(true);
    expect(isPathAllowed('/any', { allow: ['/'], disallow: ['/'] })).toBe(true);
  });

  it('supports * wildcards and a trailing $', () => {
    const rules = { allow: [], disallow: ['/*.php$', '/search*sort=', '/tmp/*/cache', '/exact$'] };
    expect(isPathAllowed('/index.php', rules)).toBe(false);
    expect(isPathAllowed('/a/b/index.php', rules)).toBe(false);
    expect(isPathAllowed('/index.php?x=1', rules)).toBe(true);
    expect(isPathAllowed('/index.phps', rules)).toBe(true);
    expect(isPathAllowed('/search?q=a&sort=asc', rules)).toBe(false);
    expect(isPathAllowed('/search?q=a', rules)).toBe(true);
    expect(isPathAllowed('/tmp/x/y/cache/1', rules)).toBe(false);
    expect(isPathAllowed('/tmp/cache', rules)).toBe(true);
    expect(isPathAllowed('/exact', rules)).toBe(false);
    expect(isPathAllowed('/exact/more', rules)).toBe(true);
    // `$` anchors the end even when the wildcard has to skip an earlier occurrence.
    expect(isPathAllowed('/a.php/b.php', rules)).toBe(false);
  });

  it('does not blow up on a pattern full of wildcards', () => {
    const rules = { allow: [], disallow: [`/${'*a'.repeat(40)}*b`] };
    const started = Date.now();
    expect(isPathAllowed(`/${'a'.repeat(5000)}`, rules)).toBe(true);
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe('parseSitemap', () => {
  it('reads page URLs from a urlset and decodes &amp;', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
        <url><loc>https://example.com/</loc><lastmod>2026-01-01</lastmod></url>
        <url>
          <loc>
            https://example.com/search?a=1&amp;b=2
          </loc>
          <image:image><image:loc>https://example.com/pic.png</image:loc></image:image>
        </url>
        <url><loc><![CDATA[https://example.com/cdata?x=1&y=2]]></loc></url>
        <url><loc></loc></url>
      </urlset>`;
    expect(parseSitemap(xml)).toEqual({
      urls: [
        'https://example.com/',
        'https://example.com/search?a=1&b=2',
        'https://example.com/cdata?x=1&y=2',
      ],
      sitemaps: [],
    });
  });

  it('reads child sitemaps from a sitemapindex', () => {
    const xml = `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <sitemap><loc>https://example.com/sitemap-posts.xml</loc></sitemap>
        <sitemap><loc>https://example.com/sitemap-pages.xml</loc></sitemap>
      </sitemapindex>`;
    expect(parseSitemap(xml)).toEqual({
      urls: [],
      sitemaps: ['https://example.com/sitemap-posts.xml', 'https://example.com/sitemap-pages.xml'],
    });
  });

  it('returns nothing for something that is not a sitemap', () => {
    expect(parseSitemap('<html><body>404</body></html>')).toEqual({ urls: [], sitemaps: [] });
    expect(parseSitemap('')).toEqual({ urls: [], sitemaps: [] });
  });
});
