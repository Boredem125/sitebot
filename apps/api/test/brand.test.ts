import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import {
  applyBrand,
  brandFromCss,
  contrast,
  detectBrand,
  firstFontFamily,
  parseColor,
  parseHead,
} from '../src/ingest/brand';
import { seedSite } from './helpers';

// Shape of a real dark, token-driven site (minified the way a bundler emits it).
const TOKEN_CSS =
  ":root{--bg-primary:#060a08;--bg-card:rgba(16,25,20,.65);--border-color:rgba(34,197,94,.15);--accent:#22c55e;" +
  "--text-primary:#ffffff;--text-secondary:#94a3b8;--danger:#ef4444;--font-main:'Inter',system-ui,-apple-system,sans-serif;" +
  "--font-mono:'Space Grotesk',monospace}*{box-sizing:border-box}" +
  'body{font-family:var(--font-main);background:var(--bg-primary);color:var(--text-primary);overflow-x:hidden}' +
  '.btn{background:var(--accent);color:#000}.alert{color:#ef4444}';

describe('parseColor', () => {
  it('reads hex, rgb, hsl and bare hsl tokens', () => {
    expect(parseColor('#22C55E')).toBe('#22c55e');
    expect(parseColor('#fff')).toBe('#ffffff');
    expect(parseColor('#11223344')).toBe('#112233');
    expect(parseColor('rgba(34, 197, 94, 0.4)')).toBe('#22c55e');
    expect(parseColor('rgb(34 197 94)')).toBe('#22c55e');
    expect(parseColor('hsl(0, 100%, 50%)')).toBe('#ff0000');
    expect(parseColor('240 100% 50%')).toBe('#0000ff');
    expect(parseColor('#060a08 url(stars.png) no-repeat')).toBe('#060a08');
  });

  it('returns null when there is no colour', () => {
    expect(parseColor('none')).toBeNull();
    expect(parseColor('')).toBeNull();
    expect(parseColor('transparent')).toBeNull();
  });
});

describe('firstFontFamily', () => {
  it('skips system and generic families', () => {
    expect(firstFontFamily("'Inter', system-ui, sans-serif")).toBe('Inter');
    expect(firstFontFamily('-apple-system, "Segoe UI", "Space Grotesk", serif')).toBe('Space Grotesk');
    expect(firstFontFamily('system-ui, sans-serif')).toBeNull();
  });

  it('rejects names that are not plain family names', () => {
    expect(firstFontFamily('x;color:red')).toBeNull();
    expect(firstFontFamily('url(evil)')).toBeNull();
  });
});

describe('brandFromCss', () => {
  it('reads a dark, token-driven design through the body rule', () => {
    expect(brandFromCss(TOKEN_CSS)).toEqual({
      color: '#22c55e',
      background: '#060a08',
      textColor: '#ffffff',
      font: 'Inter',
    });
  });

  it('reads plain values and the font shorthand', () => {
    expect(
      brandFromCss('html,body{margin:0}body{font:16px/1.5 "Lora", Georgia, serif;background-color:#fafafa;color:#222}a{color:#e11d48}a:hover{color:#e11d48}'),
    ).toEqual({ color: '#e11d48', background: '#fafafa', textColor: '#222222', font: 'Lora' });
  });

  it('falls back to the most used saturated colour when no variable names the accent', () => {
    const css = '.a{color:#7c3aed}.b{border-color:#7c3aed}.c{background:#7c3aed}.d{color:#16a34a}.e{color:#333}.f{color:#333}.g{color:#333}.h{color:#333}';
    expect(brandFromCss(css).color).toBe('#7c3aed');
  });

  it('ignores a grey "primary" and keeps looking', () => {
    expect(brandFromCss(':root{--primary:#111111;--brand:#f97316}').color).toBe('#f97316');
  });

  it('drops a text colour that is unreadable on the background, or has no background', () => {
    expect(brandFromCss('body{background:#ffffff;color:#f5f5f5}')).toEqual({ background: '#ffffff' });
    expect(brandFromCss('body{color:#ffffff}')).toEqual({});
  });

  it('returns nothing for CSS with no usable hints', () => {
    expect(brandFromCss('.x{display:none}')).toEqual({});
    expect(brandFromCss('')).toEqual({});
  });
});

describe('parseHead', () => {
  const BASE = 'https://example.com/';

  it('prefers a vector icon, collects stylesheets, and reads the Google font', () => {
    const hints = parseHead(
      `<head>
        <meta name="theme-color" content="#0f172a">
        <link rel="icon" href="/favicon.ico" sizes="32x32">
        <link rel="apple-touch-icon" href="/apple.png">
        <link rel="icon" type="image/svg+xml" href="/logo.svg" />
        <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;700&amp;family=Inter&display=swap" rel="stylesheet">
        <link rel="stylesheet" crossorigin href="/assets/index-abc.css">
        <style>body{color:#123456}</style>
      </head>`,
      BASE,
    );
    expect(hints).toEqual({
      themeColor: '#0f172a',
      logoUrl: 'https://example.com/logo.svg',
      stylesheets: ['https://example.com/assets/index-abc.css'],
      inlineCss: 'body{color:#123456}\n',
      googleFont: 'Space Grotesk',
    });
  });

  it('ignores icons and stylesheets on unsafe or non-http URLs', () => {
    const hints = parseHead(
      '<link rel="icon" href="http://192.168.0.1/i.png"><link rel="icon" href="javascript:alert(1)">' +
        '<link rel="stylesheet" href="http://localhost/a.css"><link rel="icon" href="data:image/png;base64,AAAA">',
      BASE,
    );
    expect(hints.logoUrl).toBeNull();
    expect(hints.stylesheets).toEqual([]);
  });
});

describe('detectBrand', () => {
  it('combines the page head with its stylesheet', async () => {
    const fetched: string[] = [];
    const brand = await detectBrand(
      '<link rel="icon" href="/favicon.svg" /><link rel="stylesheet" href="/assets/app.css"><div id="root"></div>',
      'https://example.com/',
      async (url) => {
        fetched.push(url);
        return url.endsWith('/assets/app.css') ? TOKEN_CSS : null;
      },
    );
    expect(brand).toEqual({
      color: '#22c55e',
      background: '#060a08',
      textColor: '#ffffff',
      font: 'Inter',
      logoUrl: 'https://example.com/favicon.svg',
    });
    expect(fetched).toEqual(['https://example.com/assets/app.css']);
  });

  it('falls back to theme-color, the Google font, and /favicon.ico', async () => {
    const brand = await detectBrand(
      '<meta name="theme-color" content="#e11d48"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Poppins:wght@400">',
      'https://example.com/docs/intro',
      async () => null,
    );
    expect(brand).toEqual({ color: '#e11d48', font: 'Poppins', logoUrl: 'https://example.com/favicon.ico' });
  });

  it('offers only the conventional favicon for a page with no hints', async () => {
    expect(await detectBrand('<p>hi</p>', 'https://example.com/', async () => null)).toEqual({
      logoUrl: 'https://example.com/favicon.ico',
    });
  });
});

describe('applyBrand', () => {
  const look = (siteId: string) =>
    env.DB.prepare('SELECT color, background, text_color, font, logo_url, brand_locked FROM sites WHERE id = ?1')
      .bind(siteId)
      .first();

  it('fills in detected values and keeps the rest', async () => {
    const { siteId } = await seedSite(env.DB);
    await applyBrand(env.DB, siteId, { background: '#000000', textColor: '#ffffff', font: 'Inter' });
    expect(await look(siteId)).toEqual({
      color: '#2563eb',
      background: '#000000',
      text_color: '#ffffff',
      font: 'Inter',
      logo_url: null,
      brand_locked: 0,
    });
  });

  it('leaves a hand-edited look alone unless forced', async () => {
    const { siteId } = await seedSite(env.DB);
    await env.DB.prepare("UPDATE sites SET color = '#111111', brand_locked = 1 WHERE id = ?1").bind(siteId).run();

    await applyBrand(env.DB, siteId, { color: '#22c55e' });
    expect(await look(siteId)).toMatchObject({ color: '#111111', brand_locked: 1 });

    await applyBrand(env.DB, siteId, { color: '#22c55e' }, true);
    expect(await look(siteId)).toMatchObject({ color: '#22c55e', brand_locked: 0 });
  });

  it('does nothing for an empty brand', async () => {
    const { siteId } = await seedSite(env.DB);
    await applyBrand(env.DB, siteId, {}, true);
    expect(await look(siteId)).toMatchObject({ color: '#2563eb', brand_locked: 0 });
  });
});

describe('contrast', () => {
  it('is 21 for black on white and 1 for equal colours', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 0);
    expect(contrast('#22c55e', '#22c55e')).toBe(1);
  });
});
