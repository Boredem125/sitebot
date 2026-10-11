const BLOCKED_SUFFIXES = ['.local', '.localhost', '.internal', '.lan', '.home', '.corp', '.test', '.invalid'];

/**
 * True when `input` is a public http(s) URL we are willing to fetch: a DNS name
 * with a dot, default port, no credentials. IP literals (v4 in any notation, v6)
 * and local-network names are refused, which rules out private and loopback targets.
 */
export function isSafeUrl(input: string): boolean {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (url.username !== '' || url.password !== '') return false;
  if (url.port !== '') return false;

  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (host.startsWith('[')) return false;
  // The URL parser rewrites decimal, hex, and octal IPv4 forms to dotted quads.
  if (/^\d+(\.\d+){3}$/.test(host)) return false;
  if (!host.includes('.')) return false;
  if (BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) return false;
  return true;
}

/** Resolves `href` against `base` and drops the fragment. Null if the result is not http(s). */
export function normalizeUrl(href: string, base?: string): string | null {
  let url: URL;
  try {
    url = new URL(href, base);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  url.hash = '';
  return url.toString();
}

/** Hostname without a leading `www.`, lowercased. */
export function bareHost(input: string): string {
  return new URL(input).hostname.toLowerCase().replace(/^www\./, '');
}
