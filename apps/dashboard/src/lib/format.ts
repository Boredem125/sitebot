import { ApiRequestError } from '../api';

const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
const dateTimeFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const numberFmt = new Intl.NumberFormat();

// The contract types timestamps as plain numbers. Anything below 1e12 can only
// be seconds (1e12 ms is 2001), so both units render correctly.
const toMs = (ts: number): number => (ts < 1e12 ? ts * 1000 : ts);

function safeDate(ts: number): Date | null {
  const d = new Date(toMs(ts));
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatDate(ts: number): string {
  const d = safeDate(ts);
  return d ? dateFmt.format(d) : '';
}

export function formatDateTime(ts: number): string {
  const d = safeDate(ts);
  return d ? dateTimeFmt.format(d) : '';
}

export function isoDate(ts: number): string | undefined {
  return safeDate(ts)?.toISOString();
}

export function formatRelative(ts: number, now: number = Date.now()): string {
  const d = safeDate(ts);
  if (!d) return '';
  const seconds = Math.round((now - d.getTime()) / 1000);
  if (seconds < 45) return 'just now';
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
  if (seconds < 7 * 86400) return `${Math.round(seconds / 86400)} d ago`;
  return dateFmt.format(d);
}

export const formatNumber = (n: number): string => numberFmt.format(Number.isFinite(n) ? n : 0);

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  const [value, unit] = kb < 1024 ? [kb, 'KB'] : [kb / 1024, 'MB'];
  // `10 MB`, not `10.0 MB`.
  return `${Number(value.toFixed(1))} ${unit}`;
}

/** `2026-10` -> `October 2026`. Falls back to the raw value if it is not `YYYY-MM`. */
export function formatMonth(month: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return month;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1));
  return new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(d);
}

/**
 * API data is untrusted: a `javascript:` or `data:` URL in an href would run
 * in the dashboard's origin. Only http(s) URLs are ever turned into links.
 */
export function safeHttpUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/** Owners type `example.com` as often as a full URL, so a missing scheme is filled in. */
export function normalizeUrl(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  const url = safeHttpUrl(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`);
  if (!url) return null;
  return new URL(url).hostname.includes('.') ? url : null;
}

const HEX = /^#[0-9a-f]{6}$/i;
export const DEFAULT_COLOR = '#4f46e5';

export const isHexColor = (value: string): boolean => HEX.test(value);

/** Colours go into inline styles, so only a strict #rrggbb is ever passed through. */
export const safeColor = (value: string): string => (HEX.test(value) ? value.toLowerCase() : DEFAULT_COLOR);

/** Black or white, whichever reads better on `hex` (WCAG relative luminance). */
export function contrastOn(hex: string): '#000000' | '#ffffff' {
  const c = safeColor(hex);
  const channel = (i: number): number => {
    const v = parseInt(c.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const lum = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  return lum > 0.4 ? '#000000' : '#ffffff';
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiRequestError) {
    if (err.status === 429) {
      return err.retryAfter !== undefined
        ? `Too many requests. Try again in ${err.retryAfter} s.`
        : 'Too many requests. Try again shortly.';
    }
    if (err.code === 'unknown' && err.status >= 500) return 'The server had a problem. Try again in a moment.';
    return err.message;
  }
  return 'Something went wrong. Try again.';
}

export const isAbort = (err: unknown): boolean => err instanceof DOMException && err.name === 'AbortError';
