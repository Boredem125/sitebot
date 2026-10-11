import { isSafeUrl, normalizeUrl } from './url';

/** What we could read of a site's look. Every field is optional: detection is best effort. */
export interface Brand {
  /** Accent colour, `#rrggbb`. */
  color?: string;
  background?: string;
  textColor?: string;
  /** One font family name. */
  font?: string;
  logoUrl?: string;
}

const MAX_HTML = 300_000;
const MAX_CSS = 1_500_000;
const MAX_STYLESHEETS = 3;

// ---------- colours ----------

const hex2 = (n: number): string =>
  Math.max(0, Math.min(255, Math.round(n)))
    .toString(16)
    .padStart(2, '0');

function hslToHex(h: number, s: number, l: number): string {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number): number => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return `#${hex2(f(0) * 255)}${hex2(f(8) * 255)}${hex2(f(4) * 255)}`;
}

const COLOR =
  /#([0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![0-9a-f])|rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)|hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%/i;
// Design-token style: `--primary: 222 47% 11%`, meant to be wrapped in hsl() by the stylesheet.
const BARE_HSL = /^\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%\s*$/;

/** First colour found in a CSS value, as `#rrggbb`. Alpha is ignored. */
export function parseColor(value: string): string | null {
  const bare = BARE_HSL.exec(value);
  if (bare) return hslToHex(Number(bare[1]), Number(bare[2]) / 100, Number(bare[3]) / 100);
  const m = COLOR.exec(value);
  if (!m) return null;
  if (m[1]) {
    const h = m[1].toLowerCase();
    if (h.length <= 4) return `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`;
    return `#${h.slice(0, 6)}`;
  }
  if (m[2] !== undefined) return `#${hex2(Number(m[2]))}${hex2(Number(m[3]))}${hex2(Number(m[4]))}`;
  return hslToHex(Number(m[5]), Number(m[6]) / 100, Number(m[7]) / 100);
}

const rgb = (hex: string): [number, number, number] => [
  parseInt(hex.slice(1, 3), 16) / 255,
  parseInt(hex.slice(3, 5), 16) / 255,
  parseInt(hex.slice(5, 7), 16) / 255,
];

/** WCAG relative luminance of `#rrggbb`. */
export function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)) as [
    number,
    number,
    number,
  ];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** HSL saturation and lightness, each 0..1. */
function satLight(hex: string): { s: number; l: number } {
  const [r, g, b] = rgb(hex);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const s = max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1));
  return { s, l };
}

// ---------- CSS ----------

const GENERIC_FONTS = new Set([
  'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-sans-serif', 'ui-serif',
  'ui-monospace', 'ui-rounded', 'inherit', 'initial', 'unset', '-apple-system', 'blinkmacsystemfont',
  'segoe ui', 'roboto', 'helvetica neue', 'helvetica', 'arial', 'noto sans', 'apple color emoji',
  'segoe ui emoji', 'segoe ui symbol', 'noto color emoji',
]);
const FONT_NAME = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,59}$/;

/** First real (non-system) family in a `font-family` list. */
export function firstFontFamily(list: string): string | null {
  for (const part of list.split(',')) {
    const name = part.trim().replace(/^["']|["']$/g, '').trim();
    if (name === '' || GENERIC_FONTS.has(name.toLowerCase()) || !FONT_NAME.test(name)) continue;
    return name;
  }
  return null;
}

// Tried in order; within one pattern the first declared variable wins.
const ACCENT_VARS = [
  /^(color-)?accent(-color|-primary|-main|-default|-500)?$/,
  /^(color-)?primary(-color|-main|-default|-500|-600)?$/,
  /^(color-)?brand(-color|-primary|-main|-default|-500)?$/,
  /^(color-)?(theme|main|highlight|link)(-color)?$/,
];
const BACKGROUND_VARS = [/^(color-)?(bg|background)(-color|-primary|-main|-base|-default|-body|-page)?$/];
const TEXT_VARS = [/^(color-)?(text|fg|foreground)(-color|-primary|-main|-base|-default|-body)?$/];
const FONT_VARS = [/^font(-family)?(-main|-sans|-body|-base|-primary|-default)?$/];

/**
 * Reads accent, background, text colour and font out of a site's CSS: first from the
 * `body` rule, then from conventionally named custom properties, and for the accent
 * finally from the most used saturated colour. Heuristic by nature; the owner can
 * override every value in the dashboard.
 */
export function brandFromCss(input: string): Omit<Brand, 'logoUrl'> {
  const css = input.slice(0, MAX_CSS).replace(/\/\*[\s\S]*?\*\//g, '');

  const vars = new Map<string, string>();
  for (const m of css.matchAll(/--([a-z0-9_-]+)\s*:\s*([^;{}]+)/gi)) {
    const name = m[1]!.toLowerCase();
    if (!vars.has(name)) vars.set(name, m[2]!.trim());
  }
  const resolve = (value: string, depth = 0): string =>
    depth > 4
      ? value
      : value.replace(/var\(\s*--([a-z0-9_-]+)\s*(?:,([^)]*))?\)/gi, (_, name: string, fallback?: string) =>
          resolve(vars.get(name.toLowerCase()) ?? fallback ?? '', depth + 1),
        );

  const body = new Map<string, string>();
  // Lookbehind, not a consumed character: `html,body{..}body{..}` must match both rules.
  for (const rule of css.matchAll(/(?<=^|[}\s,])body\s*(?:,[^{}]*)?\{([^}]*)\}/gi)) {
    for (const decl of rule[1]!.split(';')) {
      const colon = decl.indexOf(':');
      if (colon === -1) continue;
      const prop = decl.slice(0, colon).trim().toLowerCase();
      if (!body.has(prop)) body.set(prop, resolve(decl.slice(colon + 1).trim()));
    }
  }

  const fromVars = <T>(patterns: RegExp[], read: (value: string) => T | null): T | null => {
    for (const pattern of patterns) {
      for (const [name, value] of vars) {
        if (!pattern.test(name)) continue;
        const found = read(resolve(value));
        if (found !== null) return found;
      }
    }
    return null;
  };
  const colorful = (value: string): string | null => {
    const hex = parseColor(value);
    return hex && satLight(hex).s >= 0.2 ? hex : null;
  };

  const background =
    parseColor(body.get('background-color') ?? '') ??
    parseColor(body.get('background') ?? '') ??
    fromVars(BACKGROUND_VARS, parseColor);
  let textColor = parseColor(body.get('color') ?? '') ?? fromVars(TEXT_VARS, parseColor);

  // `font: 14px/1.5 Inter, sans-serif`: the family list follows the size.
  const shorthand = /\d[\w.%]*(?:\s*\/\s*[\w.%]+)?\s+(.+)$/.exec(body.get('font') ?? '')?.[1];
  const font =
    firstFontFamily(body.get('font-family') ?? '') ??
    firstFontFamily(shorthand ?? '') ??
    fromVars(FONT_VARS, firstFontFamily);

  let color = fromVars(ACCENT_VARS, colorful);
  if (!color) {
    const counts = new Map<string, number>();
    for (const m of css.matchAll(new RegExp(COLOR.source, 'gi'))) {
      const hex = parseColor(m[0]);
      if (!hex) continue;
      const { s, l } = satLight(hex);
      if (s >= 0.45 && l >= 0.25 && l <= 0.65) counts.set(hex, (counts.get(hex) ?? 0) + 1);
    }
    color = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  }

  // A text colour only makes sense with the background it was designed for, and must be readable on it.
  if (!background || (textColor && contrast(textColor, background) < 4.5)) textColor = null;

  const brand: Omit<Brand, 'logoUrl'> = {};
  if (color) brand.color = color;
  if (background) brand.background = background;
  if (textColor) brand.textColor = textColor;
  if (font) brand.font = font;
  return brand;
}

// ---------- HTML ----------

interface HeadHints {
  themeColor: string | null;
  logoUrl: string | null;
  stylesheets: string[];
  inlineCss: string;
  googleFont: string | null;
}

function attributes(tag: string): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const m of tag.matchAll(/([a-z:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi)) {
    attrs.set(m[1]!.toLowerCase(), (m[2] ?? m[3] ?? m[4] ?? '').replace(/&amp;/g, '&').trim());
  }
  return attrs;
}

/** Pulls the look-related hints out of a page's HTML: theme colour, icon, stylesheets, inline CSS. */
export function parseHead(input: string, baseUrl: string): HeadHints {
  const html = input.slice(0, MAX_HTML);
  const hints: HeadHints = { themeColor: null, logoUrl: null, stylesheets: [], inlineCss: '', googleFont: null };
  let logoScore = 0;

  for (const m of html.matchAll(/<(link|meta)\b([^>]*)>/gi)) {
    const attrs = attributes(m[2]!);
    if (m[1]!.toLowerCase() === 'meta') {
      if (attrs.get('name')?.toLowerCase() === 'theme-color') {
        hints.themeColor ??= parseColor(attrs.get('content') ?? '');
      }
      continue;
    }
    const rel = (attrs.get('rel') ?? '').toLowerCase().split(/\s+/);
    const href = attrs.get('href');
    const url = href ? normalizeUrl(href, baseUrl) : null;
    if (!url || !isSafeUrl(url)) continue;

    if (rel.includes('stylesheet')) {
      if (new URL(url).hostname === 'fonts.googleapis.com') {
        const family = new URL(url).searchParams.get('family')?.split(':')[0];
        hints.googleFont ??= family ? firstFontFamily(family) : null;
      } else {
        hints.stylesheets.push(url);
      }
    } else if (rel.includes('icon') || rel.includes('apple-touch-icon')) {
      // Vector first (sharp at any size), then the large touch icon, then whatever is declared.
      const svg = attrs.get('type') === 'image/svg+xml' || /\.svg(\?|$)/i.test(url);
      const size = parseInt(attrs.get('sizes') ?? '0', 10) || 0;
      const score = svg ? 4 : rel.includes('apple-touch-icon') ? 3 : size >= 64 ? 2 : 1;
      if (score > logoScore) {
        logoScore = score;
        hints.logoUrl = url;
      }
    }
  }
  for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) hints.inlineCss += `${m[1]}\n`;
  return hints;
}

/**
 * Works out a site's look from one of its pages. `fetchText` returns the body of a
 * URL or null; it is injected so the caller keeps control of the fetch safety rules.
 */
export async function detectBrand(
  html: string,
  pageUrl: string,
  fetchText: (url: string) => Promise<string | null>,
): Promise<Brand> {
  const hints = parseHead(html, pageUrl);
  let css = hints.inlineCss;
  for (const url of hints.stylesheets.slice(0, MAX_STYLESHEETS)) {
    if (css.length >= MAX_CSS) break;
    css += `\n${(await fetchText(url)) ?? ''}`;
  }

  const brand: Brand = brandFromCss(css);
  if (!brand.color && hints.themeColor && satLight(hints.themeColor).s >= 0.2) brand.color = hints.themeColor;
  if (!brand.font && hints.googleFont) brand.font = hints.googleFont;

  // No icon declared: browsers then look for /favicon.ico, so we point there too. It is not
  // fetched to check; the widget falls back to its own icon if the image does not load.
  const favicon = normalizeUrl('/favicon.ico', pageUrl);
  if (hints.logoUrl) brand.logoUrl = hints.logoUrl;
  else if (favicon && isSafeUrl(favicon)) brand.logoUrl = favicon;
  return brand;
}

export const isEmptyBrand = (brand: Brand): boolean => Object.keys(brand).length === 0;

/**
 * Saves a detected look. Values we could not detect keep what the site had. Unless
 * `force`, a site whose owner edited the look by hand is left alone.
 */
export async function applyBrand(db: D1Database, siteId: string, brand: Brand, force = false): Promise<void> {
  if (isEmptyBrand(brand)) return;
  await db
    .prepare(
      `UPDATE sites SET
         color = COALESCE(?2, color),
         background = COALESCE(?3, background),
         text_color = ?4,
         font = COALESCE(?5, font),
         logo_url = COALESCE(?6, logo_url),
         brand_locked = CASE WHEN ?7 = 1 THEN 0 ELSE brand_locked END
       WHERE id = ?1 AND (?7 = 1 OR brand_locked = 0)`,
    )
    .bind(
      siteId,
      brand.color ?? null,
      brand.background ?? null,
      // Not COALESCE: a text colour belongs to its background, so it is replaced along with it.
      brand.textColor ?? null,
      brand.font ?? null,
      brand.logoUrl ?? null,
      force ? 1 : 0,
    )
    .run();
}
