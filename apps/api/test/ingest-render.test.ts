import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IngestJob } from '../src/env';
import { NO_PAGES_ERROR, crawlPage, startCrawl } from '../src/ingest/crawl';
import { renderPacing, renderPage } from '../src/ingest/render';
import { newId } from '../src/util';
import { makeEnv, seedSite } from './helpers';

// Starter-question generation has its own tests; here it would add a Groq call to every ingest.
vi.mock('../src/suggest', () => ({ refreshSuggestions: async () => {} }));

const SHELL =
  '<html><head><title>Acme</title></head><body><div id="root"></div><script src="/app.js"></script></body></html>';
const RENDERED =
  '<html><head><title>Acme App</title></head><body><div id="root"><h1>Parcel tracking</h1>' +
  '<p>Acme tracks every parcel in real time and sends an alert when a delivery is late. ' +
  'Open the Shipments tab to see where each parcel is, and the Alerts tab to choose who gets notified.</p>' +
  '<a href="/pricing">Pricing</a></div></body></html>';

type Reply = { status?: number; body?: unknown };

/** A stand-in for the Browser Run binding that answers from a queue of replies. */
function fakeBrowser(replies: Reply[]) {
  const calls: { action: string; options: Record<string, unknown> }[] = [];
  return {
    calls,
    binding: {
      async quickAction(action: string, options: Record<string, unknown>): Promise<Response> {
        calls.push({ action, options });
        const reply = replies[Math.min(calls.length - 1, replies.length - 1)] ?? {};
        return Response.json(reply.body ?? {}, { status: reply.status ?? 200 });
      },
    } as unknown as BrowserRun,
  };
}

const ok = (html: string, finalUrl = 'https://example.com/'): Reply => ({
  body: { success: true, result: html, meta: { status: 200, title: 'x', finalUrl } },
});

const realWait = renderPacing.waitMs;
beforeEach(() => {
  renderPacing.waitMs = 0;
});
afterEach(() => {
  renderPacing.waitMs = realWait;
  vi.restoreAllMocks();
});

describe('renderPage', () => {
  it('returns the rendered HTML and asks for a text-only, network-idle load', async () => {
    const browser = fakeBrowser([ok(RENDERED)]);
    const page = await renderPage({ BROWSER: browser.binding }, 'https://example.com/', 'example.com');
    expect(page).toEqual({ html: RENDERED, finalUrl: 'https://example.com/' });
    expect(browser.calls).toEqual([
      {
        action: 'content',
        options: {
          url: 'https://example.com/',
          gotoOptions: { waitUntil: 'networkidle2', timeout: 30_000 },
          rejectResourceTypes: ['image', 'media', 'font'],
        },
      },
    ]);
  });

  it('waits and retries when rate limited, then gives up', async () => {
    const recovers = fakeBrowser([{ status: 429 }, ok(RENDERED)]);
    expect(await renderPage({ BROWSER: recovers.binding }, 'https://example.com/', 'example.com')).not.toBeNull();
    expect(recovers.calls).toHaveLength(2);

    const stuck = fakeBrowser([{ status: 429 }]);
    expect(await renderPage({ BROWSER: stuck.binding }, 'https://example.com/', 'example.com')).toBeNull();
    expect(stuck.calls).toHaveLength(renderPacing.attempts);
  });

  it('returns null without a binding, for unsafe URLs, and on errors', async () => {
    expect(await renderPage({}, 'https://example.com/', 'example.com')).toBeNull();

    const unused = fakeBrowser([ok(RENDERED)]);
    expect(await renderPage({ BROWSER: unused.binding }, 'http://192.168.1.1/', '192.168.1.1')).toBeNull();
    expect(await renderPage({ BROWSER: unused.binding }, 'http://localhost/', 'localhost')).toBeNull();
    expect(unused.calls).toHaveLength(0);

    for (const reply of [
      { status: 500 },
      { status: 422, body: { success: false } },
      { body: { success: false, result: RENDERED } },
      { body: { success: true, result: 42 } },
      { body: { success: true, result: RENDERED, meta: { status: 404 } } },
      { body: 'not an object' },
    ]) {
      const browser = fakeBrowser([reply]);
      expect(await renderPage({ BROWSER: browser.binding }, 'https://example.com/', 'example.com')).toBeNull();
    }
  });

  it('discards a page whose browser ended up on another or an unsafe site', async () => {
    for (const finalUrl of ['https://evil.example.net/landing', 'http://169.254.169.254/', 'http://localhost/x']) {
      const browser = fakeBrowser([ok(RENDERED, finalUrl)]);
      expect(await renderPage({ BROWSER: browser.binding }, 'https://example.com/', 'example.com')).toBeNull();
    }
    const www = fakeBrowser([ok(RENDERED, 'https://www.example.com/home')]);
    expect(await renderPage({ BROWSER: www.binding }, 'https://example.com/', 'example.com')).toMatchObject({
      finalUrl: 'https://www.example.com/home',
    });
  });

  it('discards an oversized result', async () => {
    const browser = fakeBrowser([ok('x'.repeat(2 * 1024 * 1024 + 1))]);
    expect(await renderPage({ BROWSER: browser.binding }, 'https://example.com/', 'example.com')).toBeNull();
  });
});

describe('crawl with rendering', () => {
  async function seedCrawl(startUrl: string) {
    const site = await seedSite(env.DB);
    const sourceId = newId();
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO sources (id, site_id, kind, label, status, created_at, updated_at)
       VALUES (?1, ?2, 'crawl', ?3, 'pending', ?4, ?4)`,
    )
      .bind(sourceId, site.siteId, startUrl, now)
      .run();
    return { siteId: site.siteId, sourceId };
  }

  function mockSite(pages: Record<string, string>) {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const html = pages[url];
      return html === undefined
        ? new Response('not found', { status: 404 })
        : new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    });
  }

  /** Runs the crawl job and then every page job it produces, like the queue would. */
  async function crawl(t: ReturnType<typeof makeEnv>, ids: { siteId: string; sourceId: string }) {
    await startCrawl(t.env, { type: 'crawl', ...ids });
    for (let i = 0; i < t.queue.sent.length; i++) {
      const job = t.queue.sent[i] as IngestJob;
      if (job.type === 'page') await crawlPage(t.env, job);
    }
  }

  const source = (id: string) =>
    env.DB.prepare('SELECT status, error, pages FROM sources WHERE id = ?1').bind(id).first();
  const chunkText = async (siteId: string) =>
    (
      await env.DB.prepare('SELECT title, content FROM chunks WHERE site_id = ?1 ORDER BY url, position')
        .bind(siteId)
        .all<{ title: string; content: string }>()
    ).results;

  it('renders a JavaScript shell and indexes what the browser shows', async () => {
    const browser = fakeBrowser([ok(RENDERED)]);
    const t = makeEnv({ BROWSER: browser.binding });
    const ids = await seedCrawl('https://example.com/');
    mockSite({ 'https://example.com/': SHELL });

    await crawl(t, ids);

    expect(await source(ids.sourceId)).toEqual({ status: 'ready', error: null, pages: 1 });
    const chunks = await chunkText(ids.siteId);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.title).toBe('Acme App');
    expect(chunks[0]?.content).toContain('Open the Shipments tab');
    // The link only exists after rendering, and the walk follows it.
    expect(t.queue.sent).toContainEqual({ type: 'page', ...ids, url: 'https://example.com/pricing' });
  });

  it('does not spend browser time on a page that already has text', async () => {
    const browser = fakeBrowser([ok(RENDERED)]);
    const t = makeEnv({ BROWSER: browser.binding });
    const ids = await seedCrawl('https://example.com/');
    const article = `<html><body><p>${'Plain server-rendered text about our bikes. '.repeat(8)}</p></body></html>`;
    mockSite({ 'https://example.com/': article });

    await crawl(t, ids);

    expect(browser.calls).toHaveLength(0);
    expect(await source(ids.sourceId)).toMatchObject({ status: 'ready', pages: 1 });
  });

  it('keeps the raw page when rendering is unavailable', async () => {
    const browser = fakeBrowser([{ status: 429 }]);
    const t = makeEnv({ BROWSER: browser.binding });
    const ids = await seedCrawl('https://example.com/');
    mockSite({ 'https://example.com/': SHELL });

    await crawl(t, ids);

    expect(browser.calls).toHaveLength(renderPacing.attempts);
    expect(await source(ids.sourceId)).toEqual({ status: 'error', error: NO_PAGES_ERROR, pages: 0 });
  });

  it('works as before when the binding is absent', async () => {
    const t = makeEnv();
    const ids = await seedCrawl('https://example.com/');
    mockSite({ 'https://example.com/': SHELL });

    await crawl(t, ids);
    expect(await source(ids.sourceId)).toEqual({ status: 'error', error: NO_PAGES_ERROR, pages: 0 });
  });
});
