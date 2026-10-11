import { LIMITS } from '@sitebot/shared';
import { parseJson } from '../db';
import { CRAWLER_USER_AGENT, type Env, type IngestJob } from '../env';
import { applyBrand, detectBrand } from './brand';
import { decodeEntities, extractHtml } from './extract';
import { batches, deleteChunks, indexDocument, loadSource, setSourceStatus } from './index-doc';
import { renderPage } from './render';
import { bareHost, isSafeUrl, normalizeUrl } from './url';

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;
/** Below this much text a page is treated as a JavaScript shell and rendered in a browser. */
const THIN_TEXT_CHARS = 200;
/** Applies to sitemaps named by robots.txt and, separately, to children of a sitemap index. */
const MAX_SITEMAPS = 5;
/** Product token of CRAWLER_USER_AGENT, as it would appear in a robots.txt group. */
const ROBOTS_AGENT = CRAWLER_USER_AGENT.replace(/\/.*$/, '').toLowerCase();
const NON_HTML_PATH =
  /\.(pdf|jpe?g|png|gif|webp|svg|ico|bmp|tiff?|avif|css|js|mjs|json|xml|rss|atom|txt|csv|zip|gz|tgz|tar|rar|7z|mp4|mp3|m4a|wav|ogg|webm|mov|avi|woff2?|ttf|otf|eot|docx?|xlsx?|pptx?|exe|dmg|apk|wasm|map)$/i;

export const NO_PAGES_ERROR =
  'No readable text found. The site may be down, block crawlers, or need JavaScript to show its content.';

export interface RobotsRules {
  allow: string[];
  disallow: string[];
}

interface CrawlMeta {
  mode: 'sitemap' | 'bfs';
  robots: RobotsRules;
}

type CrawlJob = Extract<IngestJob, { type: 'crawl' }>;
type PageJob = Extract<IngestJob, { type: 'page' }>;

// ---------- robots.txt and sitemaps (pure) ----------

/**
 * Returns the rules of the group addressed to `userAgent`, or of the `*` group when there is
 * none. Groups for the same agent are merged. Sitemap lines apply whatever the group.
 */
export function parseRobots(
  txt: string,
  userAgent: string = ROBOTS_AGENT,
): RobotsRules & { sitemaps: string[] } {
  const agent = userAgent.toLowerCase();
  const groups: { agents: string[]; allow: string[]; disallow: string[] }[] = [];
  const sitemaps: string[] = [];
  let group: (typeof groups)[number] | null = null;
  // Consecutive User-agent lines share one group; the first rule line closes the list.
  let listingAgents = false;

  for (const raw of txt.replace(/^﻿/, '').split(/\r\n|\r|\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === 'sitemap') {
      if (value !== '') sitemaps.push(value);
    } else if (key === 'user-agent') {
      if (!group || !listingAgents) {
        group = { agents: [], allow: [], disallow: [] };
        groups.push(group);
      }
      group.agents.push(value.toLowerCase());
      listingAgents = true;
    } else if (key === 'allow' || key === 'disallow') {
      listingAgents = false;
      // An empty Disallow means "nothing is disallowed", which is what no rule means too.
      if (group && value !== '') group[key].push(value);
    }
  }

  const own = groups.filter((g) => g.agents.includes(agent));
  const chosen = own.length > 0 ? own : groups.filter((g) => g.agents.includes('*'));
  return {
    allow: chosen.flatMap((g) => g.allow),
    disallow: chosen.flatMap((g) => g.disallow),
    sitemaps,
  };
}

/**
 * Matches a robots.txt path pattern (`*` wildcard, optional trailing `$`) against the start of
 * `path`. Done by hand rather than with a RegExp: the pattern comes from a remote site, and a
 * run of wildcards must not be able to make matching blow up.
 */
function matchesPattern(path: string, pattern: string): boolean {
  const anchored = pattern.endsWith('$');
  const parts = (anchored ? pattern.slice(0, -1) : pattern).split('*');
  const first = parts[0] ?? '';
  if (!path.startsWith(first)) return false;
  if (parts.length === 1) return !anchored || path.length === first.length;
  let pos = first.length;
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i] ?? '';
    if (anchored && i === parts.length - 1) {
      return path.length - part.length >= pos && path.endsWith(part);
    }
    const found = path.indexOf(part, pos);
    if (found === -1) return false;
    pos = found + part.length;
  }
  return true;
}

/** Longest matching rule wins, Allow wins a tie, and no matching rule means allowed. */
export function isPathAllowed(pathAndQuery: string, rules: RobotsRules): boolean {
  const longest = (patterns: string[]): number => {
    let best = -1;
    for (const p of patterns) {
      if (p !== '' && p.length > best && matchesPattern(pathAndQuery, p)) best = p.length;
    }
    return best;
  };
  return longest(rules.allow) >= longest(rules.disallow);
}

/** Reads `<loc>` entries. In a `<sitemapindex>` they name child sitemaps, otherwise pages. */
export function parseSitemap(xml: string): { urls: string[]; sitemaps: string[] } {
  const locs: string[] = [];
  // Plain or CDATA-wrapped. Every quantifier stops at a fixed character, so a hostile file
  // cannot make this backtrack.
  for (const match of xml.matchAll(/<loc>([^<]*)(?:<!\[CDATA\[([^\]]*)\]\]>[^<]*)?<\/loc>/gi)) {
    const loc = decodeEntities(match[2] ?? match[1] ?? '').trim();
    if (loc !== '') locs.push(loc);
  }
  return /<sitemapindex[\s>]/i.test(xml) ? { urls: [], sitemaps: locs } : { urls: locs, sitemaps: [] };
}

// ---------- fetching ----------

/**
 * Fetches `url`, following redirects by hand so that every hop is checked: it must be a public
 * address and, when `site` is given, stay on that site. Throws otherwise.
 */
async function safeFetch(url: string, site: string | null): Promise<{ res: Response; url: string }> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isSafeUrl(current)) throw new Error('Refused unsafe URL');
    if (site !== null && bareHost(current) !== site) throw new Error('Refused off-site URL');
    const res = await fetch(current, {
      headers: { 'User-Agent': CRAWLER_USER_AGENT },
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.status < 300 || res.status > 399 || res.status === 304) return { res, url: current };
    const location = res.headers.get('location');
    await res.body?.cancel();
    const next = location ? normalizeUrl(location, current) : null;
    if (!next) throw new Error('Redirect without a usable location');
    current = next;
  }
  throw new Error('Too many redirects');
}

/** Reads at most `max` bytes of the body and reports whether there was more. */
async function readBody(res: Response, max: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const parts: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  const reader = res.body?.getReader();
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.byteLength > max) {
      parts.push(value.subarray(0, max - size));
      size = max;
      truncated = true;
      await reader.cancel();
      break;
    }
    parts.push(value);
    size += value.byteLength;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return { bytes, truncated };
}

/** Body of a 200 response as text (cut at MAX_BODY_BYTES), or null for any failure. */
export async function fetchText(url: string, site: string | null): Promise<string | null> {
  try {
    const { res } = await safeFetch(url, site);
    if (res.status !== 200) {
      await res.body?.cancel();
      return null;
    }
    const { bytes } = await readBody(res, MAX_BODY_BYTES);
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

async function fetchPage(
  url: string,
  site: string,
): Promise<{ title: string; text: string; links: string[]; html: string; finalUrl: string }> {
  const { res, url: finalUrl } = await safeFetch(url, site);
  const contentType = res.headers.get('content-type') ?? '';
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (res.status !== 200 || !/^\s*text\/html\b/i.test(contentType) || declared > MAX_BODY_BYTES) {
    await res.body?.cancel();
    throw new Error('Not a readable HTML page');
  }
  // content-length can be absent or wrong, so the limit is enforced on the bytes as well.
  const { bytes, truncated } = await readBody(res, MAX_BODY_BYTES);
  if (truncated) throw new Error('Page too large');
  // Links resolve against where the page really lives, after redirects.
  const extracted = await extractHtml(
    new Response(bytes, { headers: { 'content-type': contentType } }),
    finalUrl,
  );
  return { ...extracted, html: new TextDecoder().decode(bytes), finalUrl };
}

/** Normalized URL if it is a page of `site` we may crawl, else null. */
function acceptUrl(raw: string, site: string, rules: RobotsRules): string | null {
  const url = normalizeUrl(raw);
  if (!url || !isSafeUrl(url) || bareHost(url) !== site) return null;
  const { pathname, search } = new URL(url);
  if (NON_HTML_PATH.test(pathname)) return null;
  return isPathAllowed(pathname + search, rules) ? url : null;
}

// ---------- jobs ----------

/** Builds the frontier for a crawl source and enqueues one page job per URL. */
export async function startCrawl(env: Env, job: CrawlJob): Promise<void> {
  const { siteId, sourceId } = job;
  const source = await loadSource(env, siteId, sourceId);
  if (!source || source.kind !== 'crawl') return;
  await setSourceStatus(env, siteId, sourceId, 'processing');

  const start = normalizeUrl(source.label);
  if (!start || !isSafeUrl(start)) {
    await setSourceStatus(env, siteId, sourceId, 'error', 'This URL cannot be crawled');
    return;
  }
  const site = bareHost(start);
  const { origin, pathname, search } = new URL(start);

  // Missing or unreadable robots.txt means no restrictions.
  const robots = parseRobots((await fetchText(`${origin}/robots.txt`, site)) ?? '');
  const rules: RobotsRules = { allow: robots.allow, disallow: robots.disallow };

  const frontier = new Set<string>();
  const full = (): boolean => frontier.size >= LIMITS.crawlMaxPages;
  const collect = (urls: string[]): void => {
    for (const raw of urls) {
      if (full()) return;
      const url = acceptUrl(raw, site, rules);
      if (url) frontier.add(url);
    }
  };
  const resolveAll = (list: string[]): string[] =>
    list.flatMap((s) => normalizeUrl(s, origin) ?? []).slice(0, MAX_SITEMAPS);

  // A sitemap may legitimately live on another host, so only the address check applies to it;
  // the URLs it lists are still filtered to this site.
  const named = resolveAll(robots.sitemaps);
  const children: string[] = [];
  for (const sitemapUrl of named.length > 0 ? named : [`${origin}/sitemap.xml`]) {
    const xml = full() ? null : await fetchText(sitemapUrl, null);
    if (xml === null) continue;
    const parsed = parseSitemap(xml);
    collect(parsed.urls);
    children.push(...parsed.sitemaps);
  }
  // One level of sitemap index only: an index listed inside a child is ignored.
  for (const sitemapUrl of resolveAll(children)) {
    const xml = full() ? null : await fetchText(sitemapUrl, null);
    if (xml !== null) collect(parseSitemap(xml).urls);
  }

  const mode: CrawlMeta['mode'] = frontier.size > 0 ? 'sitemap' : 'bfs';
  if (mode === 'bfs') {
    if (!isPathAllowed(pathname + search, rules)) {
      await setSourceStatus(env, siteId, sourceId, 'error', 'robots.txt does not allow crawling this URL');
      return;
    }
    frontier.add(start);
  }

  const urls = [...frontier];
  const meta: CrawlMeta = { mode, robots: rules };
  const insert = env.DB.prepare(
    `INSERT OR IGNORE INTO crawl_pages (source_id, url, status) VALUES (?1, ?2, 'pending')`,
  );
  const statements = [
    env.DB.prepare('UPDATE sources SET meta = ?3, updated_at = ?4 WHERE id = ?1 AND site_id = ?2').bind(
      sourceId,
      siteId,
      JSON.stringify(meta),
      Date.now(),
    ),
    env.DB.prepare('DELETE FROM crawl_pages WHERE source_id = ?1').bind(sourceId),
    ...urls.map((url) => insert.bind(sourceId, url)),
  ];
  for (const group of batches(statements)) await env.DB.batch(group);
  for (const group of batches(urls)) {
    await env.INGEST_QUEUE.sendBatch(
      group.map((url) => ({ body: { type: 'page' as const, siteId, sourceId, url } })),
    );
  }
}

/** Fetches and indexes one page of the frontier, then closes the crawl if it was the last. */
export async function crawlPage(env: Env, job: PageJob): Promise<void> {
  const { siteId, sourceId } = job;
  const source = await loadSource(env, siteId, sourceId);
  if (!source || source.kind !== 'crawl') return;
  const row = await env.DB.prepare('SELECT status FROM crawl_pages WHERE source_id = ?1 AND url = ?2')
    .bind(sourceId, job.url)
    .first<{ status: string }>();
  // Queues deliver at least once: a page that is already settled is not fetched again.
  if (!row || row.status !== 'pending') return;

  const start = normalizeUrl(source.label);
  const meta = parseJson<Partial<CrawlMeta>>(source.meta, {});
  const rules: RobotsRules = {
    allow: meta.robots?.allow ?? [],
    disallow: meta.robots?.disallow ?? [],
  };

  let page: Awaited<ReturnType<typeof fetchPage>> | null = null;
  let readable = false;
  if (start) {
    const site = bareHost(start);
    try {
      page = await fetchPage(job.url, site);
    } catch {
      // A page that cannot be fetched or parsed is recorded as an error, never retried.
      page = null;
    }
    if (page && page.text.length < THIN_TEXT_CHARS) {
      // Almost no text in the raw HTML usually means the page draws itself in the browser.
      // Only such pages are rendered: browser time is metered, plain fetches are not.
      const rendered = await renderPage(env, page.finalUrl, site);
      if (rendered) {
        const extracted = await extractHtml(
          new Response(rendered.html, { headers: { 'content-type': 'text/html; charset=utf-8' } }),
          rendered.finalUrl,
        );
        // The raw HTML stays in `page.html` for brand detection: its <head> is the same.
        if (extracted.text.length > page.text.length) page = { ...page, ...extracted };
      }
    }
    if (page) {
      // Failures past this point are ours (D1, Vectorize, Workers AI): let them throw and retry.
      const outcome = await indexDocument(env, {
        siteId,
        sourceId,
        url: job.url,
        title: page.title,
        text: page.text,
      });
      // A page with no text (typically one that renders in the browser) is not a page we read.
      readable = outcome !== 'empty';
      if (meta.mode === 'bfs') await addLinks(env, job, page.links, site, rules);
      if (job.url === start || new URL(job.url).pathname === '/') {
        await refreshBrand(env, siteId, page.html, page.finalUrl);
      }
    }
  }

  // New links were inserted above, before this page stops being 'pending': otherwise a
  // concurrent job could see an empty frontier and close the crawl too early.
  await settlePage(env, job, readable ? 'done' : 'error');
}

/**
 * Picks up the site's colours, font, and logo from its home page so the widget matches it.
 * Purely cosmetic, so a failure here never fails the crawl.
 */
async function refreshBrand(env: Env, siteId: string, html: string, pageUrl: string): Promise<void> {
  try {
    const site = await env.DB.prepare('SELECT brand_locked FROM sites WHERE id = ?1')
      .bind(siteId)
      .first<{ brand_locked: number }>();
    if (!site || site.brand_locked !== 0) return;
    const brand = await detectBrand(html, pageUrl, (url) => fetchText(url, null));
    await applyBrand(env.DB, siteId, brand);
  } catch {
    console.error('brand detection failed', { siteId });
  }
}

/**
 * Last resort for a page job that keeps failing: record it as an error so the crawl can still
 * finish instead of waiting forever on a row that stays 'pending'.
 */
export async function abandonPage(env: Env, job: PageJob): Promise<void> {
  if (!(await loadSource(env, job.siteId, job.sourceId))) return;
  await settlePage(env, job, 'error');
}

async function settlePage(env: Env, job: PageJob, status: 'done' | 'error'): Promise<void> {
  await env.DB.prepare(
    `UPDATE crawl_pages SET status = ?3 WHERE source_id = ?1 AND url = ?2 AND status = 'pending'`,
  )
    .bind(job.sourceId, job.url, status)
    .run();
  await finishIfIdle(env, job.siteId, job.sourceId);
}

/** Adds newly discovered links to the frontier, up to the page cap, and enqueues them. */
async function addLinks(
  env: Env,
  job: PageJob,
  links: string[],
  site: string,
  rules: RobotsRules,
): Promise<void> {
  const { siteId, sourceId } = job;
  const cap = LIMITS.crawlMaxPages;
  const { results } = await env.DB.prepare('SELECT url FROM crawl_pages WHERE source_id = ?1')
    .bind(sourceId)
    .all<{ url: string }>();
  const known = new Set(results.map((r) => r.url));
  const room = cap - known.size;
  const fresh: string[] = [];
  for (const link of links) {
    if (fresh.length >= room) break;
    const url = acceptUrl(link, site, rules);
    if (url && !known.has(url)) {
      known.add(url);
      fresh.push(url);
    }
  }

  // Other page jobs add links at the same time, so the cap is re-checked inside each insert.
  const insert = env.DB.prepare(
    `INSERT OR IGNORE INTO crawl_pages (source_id, url, status)
     SELECT ?1, ?2, 'pending'
     WHERE (SELECT COUNT(*) FROM crawl_pages WHERE source_id = ?1) < ?3`,
  );
  const added: string[] = [];
  for (const group of batches(fresh)) {
    const outcomes = await env.DB.batch(group.map((url) => insert.bind(sourceId, url, cap)));
    group.forEach((url, i) => {
      if ((outcomes[i]?.meta.changes ?? 0) > 0) added.push(url);
    });
  }

  const groups = batches(added);
  for (const [i, group] of groups.entries()) {
    try {
      await env.INGEST_QUEUE.sendBatch(
        group.map((url) => ({ body: { type: 'page' as const, siteId, sourceId, url } })),
      );
    } catch (err) {
      // A row without a job would stay 'pending' forever and the retry would skip it as a
      // duplicate, so take the unsent rows back out before failing.
      const remove = env.DB.prepare(
        `DELETE FROM crawl_pages WHERE source_id = ?1 AND url = ?2 AND status = 'pending'`,
      );
      for (const unsent of groups.slice(i)) {
        await env.DB.batch(unsent.map((url) => remove.bind(sourceId, url)));
      }
      throw err;
    }
  }
}

/** Once no page is pending: drops chunks of pages that are gone and sets the final status. */
async function finishIfIdle(env: Env, siteId: string, sourceId: string): Promise<void> {
  const counts = await env.DB.prepare(
    `SELECT COALESCE(SUM(status = 'pending'), 0) AS pending, COALESCE(SUM(status = 'done'), 0) AS done
     FROM crawl_pages WHERE source_id = ?1`,
  )
    .bind(sourceId)
    .first<{ pending: number; done: number }>();
  if (!counts || counts.pending > 0) return;
  if (counts.done === 0) {
    // Nothing could be read (site down, blocked). That says nothing about which pages are
    // stale, so what was indexed before stays searchable.
    await setSourceStatus(env, siteId, sourceId, 'error', NO_PAGES_ERROR, 0);
    return;
  }

  const { results: stale } = await env.DB.prepare(
    `SELECT id FROM chunks WHERE site_id = ?1 AND source_id = ?2
     AND url NOT IN (SELECT url FROM crawl_pages WHERE source_id = ?2 AND status = 'done')`,
  )
    .bind(siteId, sourceId)
    .all<{ id: string }>();
  const staleIds = stale.map((r) => r.id);
  await deleteChunks(env, siteId, staleIds);
  await setSourceStatus(env, siteId, sourceId, 'ready', null, counts.done);
}
