import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SourceRow } from '../src/db';
import { CRAWLER_USER_AGENT, type IngestJob } from '../src/env';
import { NO_PAGES_ERROR, crawlPage, startCrawl } from '../src/ingest/crawl';
import { newId } from '../src/util';
import { makeEnv, seedSite, type TestEnv } from './helpers';

// Starter-question generation has its own tests; here it would add a Groq call to every ingest.
vi.mock('../src/suggest', () => ({ refreshSuggestions: async () => {} }));

type Routes = Record<string, () => Response>;

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

/** Replaces global fetch. Unknown URLs answer 404. Returns the list of calls made. */
function mockFetch(routes: Routes): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({ url, init: init as RequestInit | undefined });
    const route = routes[url];
    return route ? route() : new Response('Not found', { status: 404 });
  });
  return calls;
}

const html =
  (title: string, body: string): (() => Response) =>
  () =>
    new Response(`<html><head><title>${title}</title></head><body>${body}</body></html>`, {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });

const plain =
  (body: string, contentType = 'text/plain'): (() => Response) =>
  () =>
    new Response(body, { headers: { 'content-type': contentType } });

const redirect =
  (location: string, status = 302): (() => Response) =>
  () =>
    new Response(null, { status, headers: { location } });

const sitemap = (urls: string[]): (() => Response) =>
  plain(`<urlset>${urls.map((u) => `<url><loc>${u}</loc></url>`).join('')}</urlset>`, 'application/xml');

const links = (urls: string[]): string => urls.map((u) => `<a href="${u}">link</a>`).join(' ');

async function seedCrawl(label: string): Promise<{ siteId: string; sourceId: string }> {
  const { siteId } = await seedSite(env.DB);
  const sourceId = newId();
  await env.DB.prepare(
    `INSERT INTO sources (id, site_id, kind, label, created_at, updated_at)
     VALUES (?1, ?2, 'crawl', ?3, 1, 1)`,
  )
    .bind(sourceId, siteId, label)
    .run();
  return { siteId, sourceId };
}

async function sourceRow(sourceId: string): Promise<SourceRow> {
  const row = await env.DB.prepare('SELECT * FROM sources WHERE id = ?1').bind(sourceId).first<SourceRow>();
  if (!row) throw new Error('source not found');
  return row;
}

async function pageStatuses(sourceId: string): Promise<Record<string, string>> {
  const { results } = await env.DB.prepare('SELECT url, status FROM crawl_pages WHERE source_id = ?1')
    .bind(sourceId)
    .all<{ url: string; status: string }>();
  return Object.fromEntries(results.map((r) => [r.url, r.status]));
}

async function chunks(siteId: string, sourceId: string): Promise<{ id: string; url: string; title: string; content: string }[]> {
  const { results } = await env.DB.prepare(
    'SELECT id, url, title, content FROM chunks WHERE site_id = ?1 AND source_id = ?2 ORDER BY url, position',
  )
    .bind(siteId, sourceId)
    .all<{ id: string; url: string; title: string; content: string }>();
  return results;
}

const pageJobs = (t: TestEnv): string[] =>
  t.queue.sent.map((job) => (job.type === 'page' ? job.url : `unexpected ${job.type} job`));

/** Runs queued page jobs, including the ones they enqueue, until the queue is empty. */
async function drain(t: TestEnv): Promise<void> {
  for (let job = t.queue.sent.shift(); job; job = t.queue.sent.shift()) {
    if (job.type !== 'page') throw new Error(`unexpected ${job.type} job`);
    await crawlPage(t.env, job);
  }
}

async function crawl(t: TestEnv, ids: { siteId: string; sourceId: string }): Promise<void> {
  await startCrawl(t.env, { type: 'crawl', ...ids });
  await drain(t);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('crawl in sitemap mode', () => {
  it('crawls the pages a sitemap lists, filtered to this site and to what robots.txt allows', async () => {
    const t = makeEnv();
    const ids = await seedCrawl('https://example.com/');
    const calls = mockFetch({
      'https://example.com/robots.txt': plain(
        'User-agent: *\nDisallow: /private\nSitemap: https://example.com/sm.xml\n',
      ),
      'https://example.com/sm.xml': sitemap([
        'https://example.com/',
        'https://example.com/a',
        'https://example.com/a#section',
        'https://www.example.com/b?x=1&amp;y=2',
        'https://example.com/private/x',
        'https://other.com/z',
        'https://example.com/manual.pdf',
        'https://example.com/logo.PNG',
        'http://example.com:8080/c',
      ]),
      'https://example.com/': html('Home', `<p>Welcome home.</p>${links(['/not-in-sitemap'])}`),
      'https://example.com/a': html('Page A', '<p>About page a.</p>'),
      'https://www.example.com/b?x=1&y=2': html('Page B', '<nav>menu</nav><p>About page b.</p>'),
    });

    await startCrawl(t.env, { type: 'crawl', ...ids });

    const expected = ['https://example.com/', 'https://example.com/a', 'https://www.example.com/b?x=1&y=2'];
    expect(t.queue.sent).toEqual(expected.map((url) => ({ type: 'page', ...ids, url })));
    expect(await pageStatuses(ids.sourceId)).toEqual(Object.fromEntries(expected.map((u) => [u, 'pending'])));
    let source = await sourceRow(ids.sourceId);
    expect(source.status).toBe('processing');
    expect(JSON.parse(source.meta)).toEqual({ mode: 'sitemap', robots: { allow: [], disallow: ['/private'] } });
    expect(source.updated_at).toBeGreaterThan(1);
    expect(calls.map((c) => c.url)).toEqual(['https://example.com/robots.txt', 'https://example.com/sm.xml']);

    await drain(t);

    source = await sourceRow(ids.sourceId);
    expect(source).toMatchObject({ status: 'ready', error: null, pages: 3 });
    expect(await pageStatuses(ids.sourceId)).toEqual(Object.fromEntries(expected.map((u) => [u, 'done'])));
    expect(await chunks(ids.siteId, ids.sourceId)).toMatchObject([
      { url: 'https://example.com/', title: 'Home', content: 'Welcome home.\nlink' },
      { url: 'https://example.com/a', title: 'Page A', content: 'About page a.' },
      { url: 'https://www.example.com/b?x=1&y=2', title: 'Page B', content: 'About page b.' },
    ]);
    for (const vector of t.vectorize.vectors.values()) expect(vector.namespace).toBe(ids.siteId);
    // Sitemap mode does not follow links found on pages.
    expect(calls.map((c) => c.url).sort()).toEqual(
      ['https://example.com/robots.txt', 'https://example.com/sm.xml', ...expected].sort(),
    );
    // Every request identifies the crawler, handles redirects itself, and has a timeout.
    for (const call of calls) {
      expect(new Headers(call.init?.headers).get('user-agent')).toBe(CRAWLER_USER_AGENT);
      expect(call.init?.redirect).toBe('manual');
      expect(call.init?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('falls back to /sitemap.xml and follows a sitemap index one level, five children at most', async () => {
    const t = makeEnv();
    const ids = await seedCrawl('https://example.com/start');
    const child = (n: number): string => `https://example.com/sitemap-${n}.xml`;
    const routes: Routes = {
      'https://example.com/sitemap.xml': plain(
        `<sitemapindex>${[1, 2, 3, 4, 5, 6, 7].map((n) => `<sitemap><loc>${child(n)}</loc></sitemap>`).join('')}</sitemapindex>`,
        'text/xml',
      ),
      // A nested index is not followed.
      [child(2)]: plain('<sitemapindex><sitemap><loc>https://example.com/deeper.xml</loc></sitemap></sitemapindex>'),
      'https://example.com/deeper.xml': sitemap(['https://example.com/too-deep']),
    };
    for (const n of [1, 3, 4, 5, 6, 7]) routes[child(n)] = sitemap([`https://example.com/page-${n}`]);
    const calls = mockFetch(routes);

    await startCrawl(t.env, { type: 'crawl', ...ids });

    expect(pageJobs(t)).toEqual([1, 3, 4, 5].map((n) => `https://example.com/page-${n}`));
    expect(calls.map((c) => c.url)).toEqual([
      'https://example.com/robots.txt',
      'https://example.com/sitemap.xml',
      ...[1, 2, 3, 4, 5].map(child),
    ]);
    expect(JSON.parse((await sourceRow(ids.sourceId)).meta).mode).toBe('sitemap');
  });

  it('caps the frontier at 200 pages', async () => {
    const t = makeEnv();
    const ids = await seedCrawl('https://example.com/');
    mockFetch({
      'https://example.com/sitemap.xml': sitemap(Array.from({ length: 300 }, (_, i) => `https://example.com/p/${i}`)),
    });

    await startCrawl(t.env, { type: 'crawl', ...ids });

    expect(t.queue.sent).toHaveLength(200);
    expect(Object.keys(await pageStatuses(ids.sourceId))).toHaveLength(200);
  });
});

describe('crawl in bfs mode', () => {
  it('walks same-site links from the start page when there is no sitemap', async () => {
    const t = makeEnv();
    // Start on www: the bare host is the same site.
    const ids = await seedCrawl('https://www.example.com/');
    const calls = mockFetch({
      'https://www.example.com/robots.txt': plain('User-agent: sitebotcrawler\nDisallow: /private\nDisallow: /*?print='),
      'https://www.example.com/': html(
        'Home',
        `<p>Home text.</p>${links([
          '/about',
          'https://example.com/blog',
          '/about#team',
          '/private/secret',
          '/blog?print=1',
          'https://other.com/external',
          'https://sub.example.com/other-host',
          'http://example.com:8080/port',
          'mailto:hi@example.com',
          '/brochure.pdf',
          '/style.css',
        ])}`,
      ),
      'https://www.example.com/about': html('About', `<p>About text.</p>${links(['/', '/team'])}`),
      'https://example.com/blog': html('Blog', `<p>Blog text.</p>${links(['https://www.example.com/about', '/private/drafts'])}`),
      'https://www.example.com/team': html('Team', '<p>Team text.</p>'),
    });

    await startCrawl(t.env, { type: 'crawl', ...ids });
    expect(pageJobs(t)).toEqual(['https://www.example.com/']);
    expect(JSON.parse((await sourceRow(ids.sourceId)).meta)).toEqual({
      mode: 'bfs',
      robots: { allow: [], disallow: ['/private', '/*?print='] },
    });

    await drain(t);

    const crawled = [
      'https://www.example.com/',
      'https://www.example.com/about',
      'https://example.com/blog',
      'https://www.example.com/team',
    ];
    expect(await pageStatuses(ids.sourceId)).toEqual(Object.fromEntries(crawled.map((u) => [u, 'done'])));
    expect(await sourceRow(ids.sourceId)).toMatchObject({ status: 'ready', error: null, pages: 4 });
    expect((await chunks(ids.siteId, ids.sourceId)).map((c) => c.title).sort()).toEqual(['About', 'Blog', 'Home', 'Team']);
    // Nothing disallowed, off-site, unsafe, or non-HTML was requested.
    const requested = calls.map((c) => c.url);
    expect(requested.sort()).toEqual(
      ['https://www.example.com/robots.txt', 'https://www.example.com/sitemap.xml', ...crawled].sort(),
    );
  });

  it('refuses a start URL that robots.txt disallows', async () => {
    const t = makeEnv();
    const ids = await seedCrawl('https://example.com/app/');
    const calls = mockFetch({ 'https://example.com/robots.txt': plain('User-agent: *\nDisallow: /app') });

    await startCrawl(t.env, { type: 'crawl', ...ids });

    expect(await sourceRow(ids.sourceId)).toMatchObject({
      status: 'error',
      error: 'robots.txt does not allow crawling this URL',
    });
    expect(t.queue.sent).toEqual([]);
    expect(calls.map((c) => c.url)).not.toContain('https://example.com/app/');
  });

  it('stops adding pages at 200, also when pages are processed concurrently', async () => {
    const t = makeEnv();
    const ids = await seedCrawl('https://example.com/');
    const many = (prefix: string, count: number): string[] =>
      Array.from({ length: count }, (_, i) => `/${prefix}/${i}`);
    mockFetch({
      'https://example.com/': html('Home', `<p>Home.</p>${links(['/one', '/two'])}`),
      'https://example.com/one': html('One', `<p>One.</p>${links(many('a', 150))}`),
      'https://example.com/two': html('Two', `<p>Two.</p>${links(many('b', 150))}`),
      'https://example.com/a/0': html('A0', `<p>A zero.</p>${links(many('c', 50))}`),
    });

    await startCrawl(t.env, { type: 'crawl', ...ids });
    await crawlPage(t.env, { type: 'page', ...ids, url: 'https://example.com/' });
    expect(pageJobs(t)).toEqual(['https://example.com/', 'https://example.com/one', 'https://example.com/two']);
    t.queue.sent.length = 0;

    // Both pages see room for 197 more and offer 150 each: the insert itself enforces the cap.
    await Promise.all([
      crawlPage(t.env, { type: 'page', ...ids, url: 'https://example.com/one' }),
      crawlPage(t.env, { type: 'page', ...ids, url: 'https://example.com/two' }),
    ]);
    const statuses = await pageStatuses(ids.sourceId);
    expect(Object.keys(statuses)).toHaveLength(200);
    // A job was enqueued for exactly the rows that were inserted.
    expect(pageJobs(t).sort()).toEqual(
      Object.keys(statuses)
        .filter((u) => /\/(a|b)\//.test(u))
        .sort(),
    );
    expect(t.queue.sent).toHaveLength(197);
    t.queue.sent.length = 0;

    // At the cap, further links are ignored.
    await crawlPage(t.env, { type: 'page', ...ids, url: 'https://example.com/a/0' });
    expect(t.queue.sent).toEqual([]);
    expect(Object.keys(await pageStatuses(ids.sourceId))).toHaveLength(200);
    expect((await sourceRow(ids.sourceId)).status).toBe('processing');
  });
});

describe('crawl safety', () => {
  it('rejects private, local, and malformed start URLs without fetching anything', async () => {
    for (const label of [
      'http://127.0.0.1/',
      'http://localhost:8787/',
      'http://169.254.169.254/latest/meta-data/',
      'http://[::1]/',
      'https://intranet.local/',
      'https://user:pass@example.com/',
      'ftp://example.com/',
      'not a url',
    ]) {
      const t = makeEnv();
      const ids = await seedCrawl(label);
      const calls = mockFetch({});

      await startCrawl(t.env, { type: 'crawl', ...ids });

      expect(await sourceRow(ids.sourceId), label).toMatchObject({ status: 'error', error: 'This URL cannot be crawled' });
      expect(calls, label).toEqual([]);
      expect(t.queue.sent, label).toEqual([]);
      vi.restoreAllMocks();
    }
  });

  it('follows up to three same-site redirects and rejects off-site or unsafe ones', async () => {
    const t = makeEnv();
    const ids = await seedCrawl('https://example.com/');
    const page = (path: string): string => `https://example.com${path}`;
    const calls = mockFetch({
      'https://example.com/sitemap.xml': sitemap(
        ['/ok', '/old', '/hops', '/loop', '/away', '/metadata', '/local', '/nowhere'].map(page),
      ),
      [page('/ok')]: html('Ok', '<p>Fine page.</p>'),
      [page('/old')]: redirect('/new', 301),
      [page('/new')]: html('New home', '<p>Moved content.</p>'),
      [page('/hops')]: redirect('https://www.example.com/hop1'),
      'https://www.example.com/hop1': redirect('/hop2', 307),
      'https://www.example.com/hop2': redirect('/hop3', 308),
      'https://www.example.com/hop3': html('Three hops', '<p>After three redirects.</p>'),
      [page('/loop')]: redirect('/loop1'),
      [page('/loop1')]: redirect('/loop2'),
      [page('/loop2')]: redirect('/loop3'),
      [page('/loop3')]: redirect('/loop4'),
      [page('/loop4')]: html('Too far', '<p>Never read.</p>'),
      [page('/away')]: redirect('https://evil.com/landing'),
      'https://evil.com/landing': html('Evil', '<p>Off-site content.</p>'),
      [page('/metadata')]: redirect('http://169.254.169.254/latest/meta-data/'),
      [page('/local')]: redirect('http://localhost/admin'),
      [page('/nowhere')]: () => new Response(null, { status: 302 }),
    });

    await crawl(t, ids);

    expect(await pageStatuses(ids.sourceId)).toEqual({
      [page('/ok')]: 'done',
      [page('/old')]: 'done',
      [page('/hops')]: 'done',
      [page('/loop')]: 'error',
      [page('/away')]: 'error',
      [page('/metadata')]: 'error',
      [page('/local')]: 'error',
      [page('/nowhere')]: 'error',
    });
    expect(await sourceRow(ids.sourceId)).toMatchObject({ status: 'ready', pages: 3 });
    // A redirected page is indexed under the URL that was crawled.
    expect(await chunks(ids.siteId, ids.sourceId)).toMatchObject([
      { url: page('/hops'), title: 'Three hops' },
      { url: page('/ok'), title: 'Ok' },
      { url: page('/old'), title: 'New home', content: 'Moved content.' },
    ]);
    const requested = calls.map((c) => c.url);
    expect(requested.filter((u) => !u.includes('example.com'))).toEqual([]);
    expect(requested).not.toContain(page('/loop4'));
  });

  it('marks unreadable pages as errors without throwing, and the source as failed if none worked', async () => {
    const t = makeEnv();
    const ids = await seedCrawl('https://example.com/');
    const page = (path: string): string => `https://example.com${path}`;
    let pulled = 0;
    let cancelled = false;
    mockFetch({
      'https://example.com/sitemap.xml': sitemap(
        ['/json', '/gone', '/broken', '/huge-declared', '/huge-stream', '/network'].map(page),
      ),
      [page('/json')]: plain('{"a":1}', 'application/json'),
      [page('/gone')]: () => new Response('<p>gone</p>', { status: 410, headers: { 'content-type': 'text/html' } }),
      [page('/broken')]: () => new Response('<p>oops</p>', { status: 500, headers: { 'content-type': 'text/html' } }),
      [page('/huge-declared')]: () =>
        new Response('<p>small after all</p>', {
          headers: { 'content-type': 'text/html', 'content-length': String(3 * 1024 * 1024) },
        }),
      // No content-length and no end: the reader has to stop on its own at 2 MB.
      [page('/huge-stream')]: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              pulled++;
              controller.enqueue(new TextEncoder().encode('<p>filler</p>'.repeat(20_000)));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { 'content-type': 'text/html' } },
        ),
      [page('/network')]: () => {
        throw new TypeError('Network connection lost');
      },
    });

    await crawl(t, ids);

    expect(new Set(Object.values(await pageStatuses(ids.sourceId)))).toEqual(new Set(['error']));
    expect(Object.keys(await pageStatuses(ids.sourceId))).toHaveLength(6);
    expect(await sourceRow(ids.sourceId)).toMatchObject({
      status: 'error',
      error: NO_PAGES_ERROR,
      pages: 0,
    });
    expect(await chunks(ids.siteId, ids.sourceId)).toEqual([]);
    expect(t.ai.calls).toEqual([]);
    expect(cancelled).toBe(true);
    // 13 bytes x 20,000 per pull: 2 MB is reached within a dozen pulls.
    expect(pulled).toBeLessThan(15);
  });

  it('does not count a page with no text as read', async () => {
    const t = makeEnv();
    const ids = await seedCrawl('https://example.com/');
    mockFetch({ 'https://example.com/': html('', '<script>app()</script>') });

    await crawl(t, ids);

    // Reporting "ready, 1 page" here would hide that the bot has nothing to answer from.
    expect(await sourceRow(ids.sourceId)).toMatchObject({ status: 'error', error: NO_PAGES_ERROR, pages: 0 });
    expect(await chunks(ids.siteId, ids.sourceId)).toEqual([]);
  });

  it('indexes the meta description of a page that renders in the browser', async () => {
    const t = makeEnv();
    const ids = await seedCrawl('https://example.com/');
    mockFetch({
      'https://example.com/': () =>
        new Response(
          '<html><head><title>Acme App</title>' +
            '<meta name="description" content="Acme tracks parcels in real time &amp; sends alerts." />' +
            '</head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>',
          { headers: { 'content-type': 'text/html' } },
        ),
    });

    await crawl(t, ids);

    expect(await sourceRow(ids.sourceId)).toMatchObject({ status: 'ready', pages: 1 });
    expect(await chunks(ids.siteId, ids.sourceId)).toMatchObject([
      { title: 'Acme App', content: 'Acme tracks parcels in real time & sends alerts.' },
    ]);
  });

  it('ignores duplicate deliveries, unknown pages, and jobs for another site', async () => {
    const t = makeEnv();
    const ids = await seedCrawl('https://example.com/');
    const other = await seedSite(env.DB);
    const calls = mockFetch({ 'https://example.com/': html('Home', '<p>Home.</p>') });
    await startCrawl(t.env, { type: 'crawl', ...ids });
    const job: IngestJob = { type: 'page', ...ids, url: 'https://example.com/' };
    const before = calls.length;

    await crawlPage(t.env, { ...job, siteId: other.siteId });
    await crawlPage(t.env, { ...job, url: 'https://example.com/never-queued' });
    expect(calls.length).toBe(before);
    expect(await pageStatuses(ids.sourceId)).toEqual({ 'https://example.com/': 'pending' });

    await crawlPage(t.env, job);
    await crawlPage(t.env, job);
    expect(calls.length).toBe(before + 1);
    expect(t.ai.calls).toHaveLength(1);
    expect(await sourceRow(ids.sourceId)).toMatchObject({ status: 'ready', pages: 1 });

    // A crawl job for a source of another site does nothing either.
    await startCrawl(t.env, { type: 'crawl', siteId: other.siteId, sourceId: ids.sourceId });
    expect(calls.length).toBe(before + 1);
    expect((await sourceRow(ids.sourceId)).status).toBe('ready');
  });
});

describe('re-crawl', () => {
  it('skips unchanged pages, re-indexes changed ones, and removes chunks of pages that are gone', async () => {
    const t = makeEnv();
    const ids = await seedCrawl('https://example.com/');
    const page = (path: string): string => `https://example.com${path}`;
    mockFetch({
      'https://example.com/sitemap.xml': sitemap(['/same', '/changes', '/removed', '/breaks'].map(page)),
      [page('/same')]: html('Same', '<p>Stays the same.</p>'),
      [page('/changes')]: html('Changes', '<p>First version.</p>'),
      [page('/removed')]: html('Removed', '<p>Will leave the sitemap.</p>'),
      [page('/breaks')]: html('Breaks', '<p>Will start failing.</p>'),
    });
    await crawl(t, ids);

    const first = await chunks(ids.siteId, ids.sourceId);
    expect(first.map((c) => c.url)).toEqual(['/breaks', '/changes', '/removed', '/same'].map(page));
    expect(t.ai.calls).toHaveLength(4);
    expect(t.vectorize.vectors.size).toBe(4);
    const idOf = (rows: typeof first, path: string): string => rows.find((c) => c.url === page(path))!.id;

    vi.restoreAllMocks();
    mockFetch({
      'https://example.com/sitemap.xml': sitemap(['/same', '/changes', '/breaks', '/added'].map(page)),
      [page('/same')]: html('Same', '<p>Stays the same.</p>'),
      [page('/changes')]: html('Changes', '<p>Second version.</p>'),
      [page('/breaks')]: () => new Response('down', { status: 503 }),
      [page('/added')]: html('Added', '<p>Brand new.</p>'),
    });
    await crawl(t, ids);

    const second = await chunks(ids.siteId, ids.sourceId);
    expect(second.map((c) => [c.url, c.content])).toEqual([
      [page('/added'), 'Brand new.'],
      [page('/changes'), 'Second version.'],
      [page('/same'), 'Stays the same.'],
    ]);
    // Only the changed and the new page were embedded again.
    expect(t.ai.calls).toHaveLength(6);
    expect(idOf(second, '/same')).toBe(idOf(first, '/same'));
    expect(idOf(second, '/changes')).not.toBe(idOf(first, '/changes'));
    // Vectors follow the chunks: the removed and the failing page are gone from the index.
    expect([...t.vectorize.vectors.keys()].sort()).toEqual(second.map((c) => c.id).sort());
    expect(await pageStatuses(ids.sourceId)).toEqual({
      [page('/same')]: 'done',
      [page('/changes')]: 'done',
      [page('/breaks')]: 'error',
      [page('/added')]: 'done',
    });
    expect(await sourceRow(ids.sourceId)).toMatchObject({ status: 'ready', error: null, pages: 3 });
  });

  it('keeps what was indexed when a re-crawl cannot read any page', async () => {
    const t = makeEnv();
    const ids = await seedCrawl('https://example.com/');
    mockFetch({ 'https://example.com/': html('Home', '<p>Home text.</p>') });
    await crawl(t, ids);
    expect(await chunks(ids.siteId, ids.sourceId)).toHaveLength(1);

    vi.restoreAllMocks();
    mockFetch({ 'https://example.com/': () => new Response('down', { status: 503 }) });
    await crawl(t, ids);

    expect(await sourceRow(ids.sourceId)).toMatchObject({ status: 'error', error: NO_PAGES_ERROR, pages: 0 });
    expect(await chunks(ids.siteId, ids.sourceId)).toHaveLength(1);
    expect(t.vectorize.vectors.size).toBe(1);
  });
});
