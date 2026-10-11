import { useEffect, useState } from 'react';

export const SITE_TABS = [
  'install',
  'content',
  'appearance',
  'conversations',
  'questions',
  'usage',
  'settings',
] as const;
export type SiteTab = (typeof SITE_TABS)[number];

export type Route =
  | { name: 'sites' }
  | { name: 'site'; id: string; tab: SiteTab }
  | { name: 'not_found' };

const isTab = (value: string | undefined): value is SiteTab =>
  value !== undefined && (SITE_TABS as readonly string[]).includes(value);

function decode(part: string): string | null {
  try {
    return decodeURIComponent(part);
  } catch {
    return null;
  }
}

export function parseHash(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts.length === 0) return { name: 'sites' };
  if (parts[0] !== 'sites') return { name: 'not_found' };
  if (parts.length === 1) return { name: 'sites' };
  const id = decode(parts[1] ?? '');
  if (!id || parts.length > 3) return { name: 'not_found' };
  const tab = parts[2];
  if (tab === undefined) return { name: 'site', id, tab: 'install' };
  return isTab(tab) ? { name: 'site', id, tab } : { name: 'not_found' };
}

export const sitesHref = '#/';

export const siteHref = (id: string, tab: SiteTab = 'install'): string =>
  `#/sites/${encodeURIComponent(id)}/${tab}`;

export function navigate(href: string): void {
  window.location.hash = href.replace(/^#/, '');
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  useEffect(() => {
    const onChange = (): void => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}
