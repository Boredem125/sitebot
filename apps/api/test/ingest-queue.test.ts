import {
  createExecutionContext,
  createMessageBatch,
  createScheduledController,
  getQueueResult,
} from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SourceRow } from '../src/db';
import type { IngestJob } from '../src/env';
import { NO_PAGES_ERROR } from '../src/ingest/crawl';
import { handleQueue, handleScheduled } from '../src/queue';
import { newId } from '../src/util';
import { makeEnv, seedSite, type TestEnv } from './helpers';

// Starter-question generation has its own tests; here it would add a Groq call to every ingest.
vi.mock('../src/suggest', () => ({ refreshSuggestions: async () => {} }));

async function seedSource(
  siteId: string,
  fields: { kind: 'crawl' | 'upload' | 'qa'; label: string; content?: string; status?: string; error?: string },
): Promise<string> {
  const id = newId();
  await env.DB.prepare(
    `INSERT INTO sources (id, site_id, kind, label, content, status, error, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, 1)`,
  )
    .bind(id, siteId, fields.kind, fields.label, fields.content ?? null, fields.status ?? 'pending', fields.error ?? null)
    .run();
  return id;
}

async function sourceRow(sourceId: string): Promise<SourceRow> {
  const row = await env.DB.prepare('SELECT * FROM sources WHERE id = ?1').bind(sourceId).first<SourceRow>();
  if (!row) throw new Error('source not found');
  return row;
}

/** Delivers the jobs as one batch (message ids m0, m1, ...) and returns what was acked and retried. */
async function deliver(
  t: TestEnv,
  jobs: IngestJob[],
  attempts = 1,
): Promise<{ acked: string[]; retried: string[] }> {
  const batch = createMessageBatch<IngestJob>(
    'sitebot-ingest',
    jobs.map((body, i) => ({ id: `m${i}`, timestamp: new Date(), attempts, body })),
  );
  const ctx = createExecutionContext();
  await handleQueue(batch, t.env, ctx);
  const result = await getQueueResult(batch, ctx);
  expect(result.ackAll).toBe(false);
  expect(result.retryBatch.retry).toBe(false);
  return { acked: result.explicitAcks, retried: result.retryMessages.map((m) => m.msgId) };
}

/** Makes embedding fail for any text that contains `marker`. */
function failEmbeddingFor(t: TestEnv, marker: string): void {
  const run = t.ai.run.bind(t.ai);
  vi.spyOn(t.ai, 'run').mockImplementation(async (model, input) => {
    if ((input as { text: string[] }).text.some((text) => text.includes(marker))) {
      throw new Error('model unavailable');
    }
    return run(model, input);
  });
}

const html = (title: string, body: string): Response =>
  new Response(`<html><head><title>${title}</title></head><body>${body}</body></html>`, {
    headers: { 'content-type': 'text/html' },
  });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('handleQueue', () => {
  it('dispatches each job type and acks the messages', async () => {
    const t = makeEnv();
    const { siteId } = await seedSite(env.DB);
    const crawlId = await seedSource(siteId, { kind: 'crawl', label: 'https://example.com/' });
    const qaId = await seedSource(siteId, { kind: 'qa', label: 'Open on Sunday?', content: 'No.' });
    const uploadId = await seedSource(siteId, { kind: 'upload', label: 'gone.txt' });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) =>
      String(input) === 'https://example.com/' ? html('Home', '<p>Home text.</p>') : new Response('', { status: 404 }),
    );

    const first = await deliver(t, [
      { type: 'crawl', siteId, sourceId: crawlId },
      { type: 'qa', siteId, sourceId: qaId },
      { type: 'upload', siteId, sourceId: uploadId },
    ]);
    expect(first).toEqual({ acked: ['m0', 'm1', 'm2'], retried: [] });
    expect((await sourceRow(crawlId)).status).toBe('processing');
    expect((await sourceRow(qaId)).status).toBe('ready');
    // The upload job ran too: its file does not exist, which is a handled outcome, not a retry.
    expect(await sourceRow(uploadId)).toMatchObject({ status: 'error', error: 'Uploaded file not found' });
    expect(t.queue.sent).toEqual([{ type: 'page', siteId, sourceId: crawlId, url: 'https://example.com/' }]);

    const second = await deliver(t, t.queue.sent.splice(0));
    expect(second).toEqual({ acked: ['m0'], retried: [] });
    expect(await sourceRow(crawlId)).toMatchObject({ status: 'ready', pages: 1 });
  });

  it('retries a message whose job throws, without failing the rest of the batch', async () => {
    const t = makeEnv();
    const { siteId } = await seedSite(env.DB);
    const ok1 = await seedSource(siteId, { kind: 'qa', label: 'First?', content: 'One.' });
    const bad = await seedSource(siteId, { kind: 'qa', label: 'Broken?', content: 'SECRET-CONTENT' });
    const ok2 = await seedSource(siteId, { kind: 'qa', label: 'Third?', content: 'Three.' });
    failEmbeddingFor(t, 'SECRET-CONTENT');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await deliver(t, [
      { type: 'qa', siteId, sourceId: ok1 },
      { type: 'qa', siteId, sourceId: bad },
      { type: 'qa', siteId, sourceId: ok2 },
    ]);

    expect(result).toEqual({ acked: ['m0', 'm2'], retried: ['m1'] });
    expect((await sourceRow(ok1)).status).toBe('ready');
    expect((await sourceRow(ok2)).status).toBe('ready');
    expect((await sourceRow(bad)).status).toBe('pending');

    // The log names the job by type and ids, and carries none of its content.
    expect(logged).toHaveBeenCalledTimes(1);
    const line = JSON.stringify(logged.mock.calls[0]);
    expect(line).toContain(bad);
    expect(line).toContain(siteId);
    expect(line).toContain('"type":"qa"');
    expect(line).not.toContain('SECRET-CONTENT');
    expect(line).not.toContain('Broken?');
  });

  it('gives up on the last delivery so the source does not stay unfinished', async () => {
    const t = makeEnv();
    const { siteId } = await seedSite(env.DB);
    const qaId = await seedSource(siteId, { kind: 'qa', label: 'Broken?', content: 'FAILS' });
    const crawlId = await seedSource(siteId, { kind: 'crawl', label: 'https://example.com/' });
    await env.DB.prepare(`INSERT INTO crawl_pages (source_id, url) VALUES (?1, 'https://example.com/')`)
      .bind(crawlId)
      .run();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => html('Home', '<p>FAILS to embed.</p>'));
    failEmbeddingFor(t, 'FAILS');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const jobs: IngestJob[] = [
      { type: 'qa', siteId, sourceId: qaId },
      { type: 'page', siteId, sourceId: crawlId, url: 'https://example.com/' },
    ];

    // Earlier deliveries are retried and leave everything as it was.
    expect(await deliver(t, jobs, 3)).toEqual({ acked: [], retried: ['m0', 'm1'] });
    expect((await sourceRow(qaId)).status).toBe('pending');

    // wrangler.jsonc sets max_retries 3, so the fourth delivery is the last.
    expect(await deliver(t, jobs, 4)).toEqual({ acked: ['m0', 'm1'], retried: [] });
    expect(await sourceRow(qaId)).toMatchObject({ status: 'error', error: 'Processing failed, try again' });
    const page = await env.DB.prepare('SELECT status FROM crawl_pages WHERE source_id = ?1').bind(crawlId).first();
    expect(page).toEqual({ status: 'error' });
    expect(await sourceRow(crawlId)).toMatchObject({ status: 'error', error: NO_PAGES_ERROR });
  });

  it('acks jobs for sources that no longer exist', async () => {
    const t = makeEnv();
    const { siteId } = await seedSite(env.DB);
    const result = await deliver(t, [
      { type: 'crawl', siteId, sourceId: newId() },
      { type: 'page', siteId, sourceId: newId(), url: 'https://example.com/' },
      { type: 'upload', siteId, sourceId: newId() },
      { type: 'qa', siteId, sourceId: newId() },
    ]);
    expect(result).toEqual({ acked: ['m0', 'm1', 'm2', 'm3'], retried: [] });
  });
});

describe('handleScheduled', () => {
  it('re-queues finished crawl sources and purges expired rows', async () => {
    const t = makeEnv();
    const a = await seedSite(env.DB);
    const b = await seedSite(env.DB);
    const ready = await seedSource(a.siteId, { kind: 'crawl', label: 'https://a.example.com/', status: 'ready' });
    const failed = await seedSource(b.siteId, {
      kind: 'crawl',
      label: 'https://b.example.com/',
      status: 'error',
      error: NO_PAGES_ERROR,
    });
    const running = await seedSource(a.siteId, { kind: 'crawl', label: 'https://c.example.com/', status: 'processing' });
    const waiting = await seedSource(a.siteId, { kind: 'crawl', label: 'https://d.example.com/', status: 'pending' });
    const upload = await seedSource(a.siteId, { kind: 'upload', label: 'notes.txt', status: 'ready' });
    const qa = await seedSource(a.siteId, { kind: 'qa', label: 'Q?', content: 'A.', status: 'ready' });

    const now = Date.now();
    const tag = newId();
    await env.DB.batch([
      env.DB.prepare('INSERT INTO rate_limits (key, bucket, count, expires_at) VALUES (?1, 1, 1, ?2)').bind(`${tag}:old`, now - 60_000),
      env.DB.prepare('INSERT INTO rate_limits (key, bucket, count, expires_at) VALUES (?1, 1, 1, ?2)').bind(`${tag}:live`, now + 60_000),
      env.DB.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?1, ?2, ?3)').bind(`${tag}:old`, a.userId, now - 60_000),
      env.DB.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?1, ?2, ?3)').bind(`${tag}:live`, a.userId, now + 60_000),
    ]);

    await handleScheduled(createScheduledController({ cron: '0 3 * * 1' }), t.env, createExecutionContext());

    // Other tests may have left crawl sources behind, so check ours rather than the whole list.
    expect(t.queue.sent).toContainEqual({ type: 'crawl', siteId: a.siteId, sourceId: ready });
    expect(t.queue.sent).toContainEqual({ type: 'crawl', siteId: b.siteId, sourceId: failed });
    const queued = t.queue.sent.map((job) => job.sourceId);
    for (const id of [running, waiting, upload, qa]) expect(queued).not.toContain(id);
    expect(t.queue.sent.every((job) => job.type === 'crawl')).toBe(true);
    expect(new Set(queued).size).toBe(queued.length);

    expect(await sourceRow(ready)).toMatchObject({ status: 'pending', error: null });
    expect(await sourceRow(failed)).toMatchObject({ status: 'pending', error: null });
    expect((await sourceRow(ready)).updated_at).toBeGreaterThanOrEqual(now);
    expect(await sourceRow(running)).toMatchObject({ status: 'processing', updated_at: 1 });
    expect(await sourceRow(waiting)).toMatchObject({ status: 'pending', updated_at: 1 });
    expect(await sourceRow(upload)).toMatchObject({ status: 'ready', updated_at: 1 });
    expect(await sourceRow(qa)).toMatchObject({ status: 'ready', updated_at: 1 });

    const limits = await env.DB.prepare('SELECT key FROM rate_limits WHERE key LIKE ?1').bind(`${tag}:%`).all();
    expect(limits.results).toEqual([{ key: `${tag}:live` }]);
    const sessions = await env.DB.prepare('SELECT id FROM sessions WHERE id LIKE ?1').bind(`${tag}:%`).all();
    expect(sessions.results).toEqual([{ id: `${tag}:live` }]);
  });

  it('enqueues many sources in batches of at most 100', async () => {
    const t = makeEnv();
    const { siteId } = await seedSite(env.DB);
    const insert = env.DB.prepare(
      `INSERT INTO sources (id, site_id, kind, label, status, created_at, updated_at)
       VALUES (?1, ?2, 'crawl', 'https://example.com/', 'ready', 1, 1)`,
    );
    const ids = Array.from({ length: 130 }, () => newId());
    await env.DB.batch(ids.slice(0, 100).map((id) => insert.bind(id, siteId)));
    await env.DB.batch(ids.slice(100).map((id) => insert.bind(id, siteId)));
    const sendBatch = vi.spyOn(t.queue, 'sendBatch');

    await handleScheduled(createScheduledController(), t.env, createExecutionContext());

    const queued = new Set(t.queue.sent.map((job) => job.sourceId));
    for (const id of ids) expect(queued.has(id)).toBe(true);
    expect(sendBatch.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const [messages] of sendBatch.mock.calls) expect([...messages].length).toBeLessThanOrEqual(100);
  });
});
