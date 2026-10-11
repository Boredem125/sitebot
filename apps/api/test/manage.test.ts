import { describe, expect, it } from 'vitest';
import type { ApiError, Site, Source, User } from '@sitebot/shared';
import { api } from '../src/api';
import { newId } from '../src/util';
import { fakeVector, makeEnv, type TestEnv } from './helpers';

interface CallInit {
  method?: string;
  json?: unknown;
  body?: BodyInit;
  cookie?: string;
  origin?: string;
  ip?: string;
}

async function call(t: TestEnv, path: string, init: CallInit = {}): Promise<Response> {
  const headers = new Headers();
  if (init.json !== undefined) headers.set('content-type', 'application/json');
  if (init.cookie) headers.set('cookie', init.cookie);
  if (init.origin) headers.set('origin', init.origin);
  if (init.ip) headers.set('cf-connecting-ip', init.ip);
  const body = init.json !== undefined ? JSON.stringify(init.json) : init.body;
  return api.request(path, { method: init.method ?? (body === undefined ? 'GET' : 'POST'), headers, body }, t.env);
}

const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;

interface Account {
  user: User;
  cookie: string;
}

async function signUp(t: TestEnv): Promise<Account> {
  const res = await call(t, '/auth/signup', {
    json: { email: `${newId()}@example.com`, password: 'a-long-enough-password' },
    // Signup is rate limited per IP, so every test account comes from its own address.
    ip: `test-ip-${newId()}`,
  });
  expect(res.status).toBe(200);
  const token = /sb_session=([^;]*)/.exec(res.headers.get('set-cookie') ?? '')?.[1] ?? '';
  return { user: (await json<{ user: User }>(res)).user, cookie: `sb_session=${token}` };
}

/** A site, with the crawl source that creating it adds. */
async function createSite(t: TestEnv, account: Account, url = 'https://example.com'): Promise<{ site: Site; crawl: Source }> {
  const res = await call(t, '/sites', { json: { name: 'My Site', url }, cookie: account.cookie });
  expect(res.status).toBe(200);
  const { site } = await json<{ site: Site }>(res);
  const crawl = (await listSources(t, account, site.id))[0];
  if (!crawl) throw new Error('site has no crawl source');
  return { site, crawl };
}

async function listSources(t: TestEnv, account: Account, siteId: string): Promise<Source[]> {
  const res = await call(t, `/sites/${siteId}/sources`, { cookie: account.cookie });
  expect(res.status).toBe(200);
  return (await json<{ sources: Source[] }>(res)).sources;
}

async function addUpload(t: TestEnv, account: Account, siteId: string, name = 'notes.txt'): Promise<Source> {
  const form = new FormData();
  form.append('file', new File(['handbook text'], name, { type: 'text/plain' }));
  const res = await call(t, `/sites/${siteId}/sources/upload`, { body: form, cookie: account.cookie });
  expect(res.status).toBe(200);
  return (await json<{ source: Source }>(res)).source;
}

async function addQa(t: TestEnv, account: Account, siteId: string): Promise<Source> {
  const res = await call(t, `/sites/${siteId}/sources/qa`, {
    json: { question: 'Do you ship abroad?', answer: 'Yes.' },
    cookie: account.cookie,
  });
  expect(res.status).toBe(200);
  return (await json<{ source: Source }>(res)).source;
}

/** Chunk rows in D1 plus the vectors that go with them, as the ingest pipeline leaves them. */
async function seedChunks(t: TestEnv, siteId: string, sourceId: string, count: number): Promise<string[]> {
  const ids = Array.from({ length: count }, () => newId());
  const insert = t.env.DB.prepare(
    `INSERT INTO chunks (id, site_id, source_id, url, title, content, doc_hash, position, created_at)
     VALUES (?1, ?2, ?3, '', 'Title', ?4, 'hash', ?5, ?6)`,
  );
  for (let i = 0; i < ids.length; i += 50) {
    await t.env.DB.batch(
      ids.slice(i, i + 50).map((id, j) => insert.bind(id, siteId, sourceId, `chunk ${i + j}`, i + j, Date.now())),
    );
  }
  await t.vectorize.upsert(ids.map((id) => ({ id, values: fakeVector(id), namespace: siteId })));
  return ids;
}

async function seedCrawlPages(db: D1Database, sourceId: string, count: number): Promise<void> {
  await db.batch(
    Array.from({ length: count }, (_, i) =>
      db
        .prepare(`INSERT INTO crawl_pages (source_id, url, status) VALUES (?1, ?2, 'done')`)
        .bind(sourceId, `https://example.com/page-${i}`),
    ),
  );
}

async function count(db: D1Database, table: string, column: string, value: string): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?1`).bind(value).first<{ n: number }>();
  return row?.n ?? 0;
}

const vectorsOf = (t: TestEnv, siteId: string): string[] =>
  [...t.vectorize.vectors.values()].filter((v) => v.namespace === siteId).map((v) => v.id);

const objectsOf = async (t: TestEnv, siteId: string): Promise<string[]> =>
  (await t.env.UPLOADS.list({ prefix: `${siteId}/` })).objects.map((o) => o.key);

const r2KeyOf = async (db: D1Database, sourceId: string): Promise<string> =>
  (await db.prepare('SELECT r2_key FROM sources WHERE id = ?1').bind(sourceId).first<{ r2_key: string }>())?.r2_key ?? '';

async function setStatus(db: D1Database, sourceId: string, status: string, error: string | null = null): Promise<void> {
  await db.prepare('UPDATE sources SET status = ?2, error = ?3, updated_at = 1000 WHERE id = ?1').bind(sourceId, status, error).run();
}

describe('DELETE /sites/:id/sources/:sid', () => {
  it('removes the source, its chunks, its vectors, and its file, and nothing else', async () => {
    const t = makeEnv();
    const a = await signUp(t);
    const { site, crawl } = await createSite(t, a);
    const upload = await addUpload(t, a, site.id);
    const qa = await addQa(t, a, site.id);
    const uploadKey = await r2KeyOf(t.env.DB, upload.id);
    const otherUpload = await addUpload(t, a, site.id, 'other.txt');
    const otherKey = await r2KeyOf(t.env.DB, otherUpload.id);

    // More than one batch of 100, so the batching is exercised too.
    const uploadChunks = await seedChunks(t, site.id, upload.id, 130);
    const crawlChunks = await seedChunks(t, site.id, crawl.id, 3);
    const qaChunks = await seedChunks(t, site.id, qa.id, 1);
    await seedCrawlPages(t.env.DB, crawl.id, 4);
    expect(await objectsOf(t, site.id)).toHaveLength(2);

    const res = await call(t, `/sites/${site.id}/sources/${upload.id}`, { method: 'DELETE', cookie: a.cookie });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    expect(await count(t.env.DB, 'chunks', 'source_id', upload.id)).toBe(0);
    expect(await count(t.env.DB, 'sources', 'id', upload.id)).toBe(0);
    for (const id of uploadChunks) expect(t.vectorize.vectors.has(id)).toBe(false);
    expect(await t.env.UPLOADS.head(uploadKey)).toBeNull();

    // The other sources of the same site are untouched.
    expect(vectorsOf(t, site.id).sort()).toEqual([...crawlChunks, ...qaChunks].sort());
    expect(await count(t.env.DB, 'chunks', 'source_id', crawl.id)).toBe(3);
    expect(await count(t.env.DB, 'chunks', 'source_id', qa.id)).toBe(1);
    expect(await count(t.env.DB, 'crawl_pages', 'source_id', crawl.id)).toBe(4);
    expect(await objectsOf(t, site.id)).toEqual([otherKey]);
    expect((await listSources(t, a, site.id)).map((s) => s.id).sort()).toEqual([crawl.id, qa.id, otherUpload.id].sort());

    // A second delete finds nothing.
    const again = await call(t, `/sites/${site.id}/sources/${upload.id}`, { method: 'DELETE', cookie: a.cookie });
    expect(again.status).toBe(404);
    expect((await json<ApiError>(again)).code).toBe('not_found');
  });

  it('removes the crawl frontier of a crawl source', async () => {
    const t = makeEnv();
    const a = await signUp(t);
    const { site, crawl } = await createSite(t, a);
    const chunks = await seedChunks(t, site.id, crawl.id, 5);
    await seedCrawlPages(t.env.DB, crawl.id, 6);

    const res = await call(t, `/sites/${site.id}/sources/${crawl.id}`, { method: 'DELETE', cookie: a.cookie });
    expect(res.status).toBe(200);
    expect(await count(t.env.DB, 'crawl_pages', 'source_id', crawl.id)).toBe(0);
    expect(await count(t.env.DB, 'chunks', 'source_id', crawl.id)).toBe(0);
    for (const id of chunks) expect(t.vectorize.vectors.has(id)).toBe(false);
    expect(await listSources(t, a, site.id)).toEqual([]);
    // The site itself stays.
    expect((await call(t, `/sites/${site.id}`, { cookie: a.cookie })).status).toBe(200);
  });

  it('refuses a source id that belongs to another site of the same user', async () => {
    const t = makeEnv();
    const a = await signUp(t);
    const one = await createSite(t, a, 'https://one.example.com');
    const two = await createSite(t, a, 'https://two.example.com');
    const chunks = await seedChunks(t, one.site.id, one.crawl.id, 2);

    const res = await call(t, `/sites/${two.site.id}/sources/${one.crawl.id}`, { method: 'DELETE', cookie: a.cookie });
    expect(res.status).toBe(404);
    expect(await count(t.env.DB, 'sources', 'id', one.crawl.id)).toBe(1);
    expect(vectorsOf(t, one.site.id).sort()).toEqual([...chunks].sort());
  });

  it('keeps the vectors findable when Vectorize fails, so the delete can be retried', async () => {
    const t = makeEnv();
    const a = await signUp(t);
    const { site, crawl } = await createSite(t, a);
    await seedChunks(t, site.id, crawl.id, 3);
    const working = t.vectorize.deleteByIds;
    t.vectorize.deleteByIds = async () => {
      throw new Error('vectorize down');
    };

    const failed = await call(t, `/sites/${site.id}/sources/${crawl.id}`, { method: 'DELETE', cookie: a.cookie });
    expect(failed.status).toBe(500);
    // Nothing that names the vectors was removed, so none of them is orphaned.
    expect(await count(t.env.DB, 'sources', 'id', crawl.id)).toBe(1);
    expect(await count(t.env.DB, 'chunks', 'source_id', crawl.id)).toBe(3);

    t.vectorize.deleteByIds = working;
    const retried = await call(t, `/sites/${site.id}/sources/${crawl.id}`, { method: 'DELETE', cookie: a.cookie });
    expect(retried.status).toBe(200);
    expect(vectorsOf(t, site.id)).toEqual([]);
  });
});

describe('DELETE /sites/:id', () => {
  it('removes the site and everything stored for it, and leaves another user\'s site alone', async () => {
    const t = makeEnv();
    const a = await signUp(t);
    const b = await signUp(t);
    const mine = await createSite(t, a);
    const theirs = await createSite(t, b, 'https://b.example.org');
    const db = t.env.DB;

    const upload = await addUpload(t, a, mine.site.id);
    await addUpload(t, a, mine.site.id, 'second.txt');
    await addQa(t, a, mine.site.id);
    await seedChunks(t, mine.site.id, mine.crawl.id, 120);
    await seedChunks(t, mine.site.id, upload.id, 4);
    await seedCrawlPages(db, mine.crawl.id, 3);
    const conversation = newId();
    const now = Date.now();
    await db.batch([
      db.prepare('INSERT INTO conversations (id, site_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)').bind(conversation, mine.site.id, now),
      db
        .prepare(`INSERT INTO messages (id, conversation_id, site_id, role, content, created_at) VALUES (?1, ?2, ?3, 'user', 'hello', ?4)`)
        .bind(newId(), conversation, mine.site.id, now),
      db.prepare(`INSERT INTO usage_daily (site_id, day, messages) VALUES (?1, '2026-10-01', 3)`).bind(mine.site.id),
      db
        .prepare(`INSERT INTO leads (id, site_id, conversation_id, email, question, created_at) VALUES (?1, ?2, ?3, 'v@example.com', 'q', ?4)`)
        .bind(newId(), mine.site.id, conversation, now),
    ]);

    const theirUpload = await addUpload(t, b, theirs.site.id);
    const theirChunks = await seedChunks(t, theirs.site.id, theirs.crawl.id, 3);
    await seedCrawlPages(db, theirs.crawl.id, 2);
    expect(await objectsOf(t, mine.site.id)).toHaveLength(2);

    const res = await call(t, `/sites/${mine.site.id}`, { method: 'DELETE', cookie: a.cookie });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    expect(await count(db, 'sites', 'id', mine.site.id)).toBe(0);
    for (const table of ['sources', 'chunks', 'conversations', 'messages', 'usage_daily', 'leads']) {
      expect(await count(db, table, 'site_id', mine.site.id), table).toBe(0);
    }
    expect(await count(db, 'crawl_pages', 'source_id', mine.crawl.id)).toBe(0);
    expect(vectorsOf(t, mine.site.id)).toEqual([]);
    expect(await objectsOf(t, mine.site.id)).toEqual([]);
    expect((await call(t, `/sites/${mine.site.id}`, { cookie: a.cookie })).status).toBe(404);
    expect(await json<{ sites: Site[] }>(await call(t, '/sites', { cookie: a.cookie }))).toEqual({ sites: [] });
    // The account itself is not part of the site.
    expect((await call(t, '/auth/me', { cookie: a.cookie })).status).toBe(200);

    // B's site, content, vectors and file are all still there.
    expect((await call(t, `/sites/${theirs.site.id}`, { cookie: b.cookie })).status).toBe(200);
    expect((await listSources(t, b, theirs.site.id)).map((s) => s.id).sort()).toEqual([theirs.crawl.id, theirUpload.id].sort());
    expect(await count(db, 'chunks', 'site_id', theirs.site.id)).toBe(3);
    expect(await count(db, 'crawl_pages', 'source_id', theirs.crawl.id)).toBe(2);
    expect(vectorsOf(t, theirs.site.id).sort()).toEqual([...theirChunks].sort());
    expect(await objectsOf(t, theirs.site.id)).toHaveLength(1);
  });

  it('leaves the site in place when Vectorize fails, so nothing is orphaned', async () => {
    const t = makeEnv();
    const a = await signUp(t);
    const { site, crawl } = await createSite(t, a);
    await addUpload(t, a, site.id);
    await seedChunks(t, site.id, crawl.id, 2);
    t.vectorize.deleteByIds = async () => {
      throw new Error('vectorize down');
    };

    const res = await call(t, `/sites/${site.id}`, { method: 'DELETE', cookie: a.cookie });
    expect(res.status).toBe(500);
    expect(await count(t.env.DB, 'sites', 'id', site.id)).toBe(1);
    expect(await count(t.env.DB, 'chunks', 'site_id', site.id)).toBe(2);
    expect(vectorsOf(t, site.id)).toHaveLength(2);
    expect(await objectsOf(t, site.id)).toHaveLength(1);
  });

  it('is refused from a foreign Origin', async () => {
    const t = makeEnv();
    const a = await signUp(t);
    const { site } = await createSite(t, a);
    const res = await call(t, `/sites/${site.id}`, { method: 'DELETE', cookie: a.cookie, origin: 'https://evil.example' });
    expect(res.status).toBe(403);
    expect(await count(t.env.DB, 'sites', 'id', site.id)).toBe(1);
  });
});

describe('POST /sites/:id/sources/:sid/recrawl', () => {
  it('sets the source back to pending and enqueues exactly one crawl job', async () => {
    const t = makeEnv();
    const a = await signUp(t);
    const { site, crawl } = await createSite(t, a);
    await setStatus(t.env.DB, crawl.id, 'error', 'robots.txt does not allow crawling this URL');
    const chunks = await seedChunks(t, site.id, crawl.id, 2);
    const jobsBefore = t.queue.sent.length;

    const res = await call(t, `/sites/${site.id}/sources/${crawl.id}/recrawl`, { method: 'POST', cookie: a.cookie });
    expect(res.status).toBe(200);
    const { source } = await json<{ source: Source }>(res);
    expect(source).toMatchObject({ id: crawl.id, siteId: site.id, kind: 'crawl', status: 'pending', error: null });
    expect(Math.abs(source.updatedAt - Date.now())).toBeLessThan(60_000);
    expect(source.createdAt).toBe(crawl.createdAt);

    expect(t.queue.sent.slice(jobsBefore)).toEqual([{ type: 'crawl', siteId: site.id, sourceId: crawl.id }]);
    // What is indexed keeps answering until the new crawl replaces it.
    expect(vectorsOf(t, site.id).sort()).toEqual([...chunks].sort());
  });

  it('works for a source that finished, too', async () => {
    const t = makeEnv();
    const a = await signUp(t);
    const { site, crawl } = await createSite(t, a);
    await setStatus(t.env.DB, crawl.id, 'ready');
    const res = await call(t, `/sites/${site.id}/sources/${crawl.id}/recrawl`, { method: 'POST', cookie: a.cookie });
    expect(res.status).toBe(200);
    expect((await json<{ source: Source }>(res)).source.status).toBe('pending');
  });

  it('answers 400 for an upload or Q&A source', async () => {
    const t = makeEnv();
    const a = await signUp(t);
    const { site } = await createSite(t, a);
    const upload = await addUpload(t, a, site.id);
    const qa = await addQa(t, a, site.id);
    const jobsBefore = t.queue.sent.length;

    for (const source of [upload, qa]) {
      await setStatus(t.env.DB, source.id, 'ready');
      const res = await call(t, `/sites/${site.id}/sources/${source.id}/recrawl`, { method: 'POST', cookie: a.cookie });
      expect(res.status, source.kind).toBe(400);
      expect((await json<ApiError>(res)).code).toBe('invalid');
      const row = await t.env.DB.prepare('SELECT status FROM sources WHERE id = ?1').bind(source.id).first<{ status: string }>();
      expect(row?.status).toBe('ready');
    }
    expect(t.queue.sent).toHaveLength(jobsBefore);
  });

  it('answers 409 while the source is queued or being indexed', async () => {
    const t = makeEnv();
    const a = await signUp(t);
    const { site, crawl } = await createSite(t, a);
    const jobsBefore = t.queue.sent.length;

    for (const status of ['pending', 'processing']) {
      await setStatus(t.env.DB, crawl.id, status);
      const res = await call(t, `/sites/${site.id}/sources/${crawl.id}/recrawl`, { method: 'POST', cookie: a.cookie });
      expect(res.status, status).toBe(409);
      expect((await json<ApiError>(res)).code).toBe('conflict');
      const row = await t.env.DB.prepare('SELECT status, updated_at FROM sources WHERE id = ?1').bind(crawl.id).first();
      expect(row).toEqual({ status, updated_at: 1000 });
    }
    expect(t.queue.sent).toHaveLength(jobsBefore);
  });

  it('is limited to 6 per hour per site', async () => {
    const t = makeEnv();
    const a = await signUp(t);
    const { site, crawl } = await createSite(t, a);
    const other = await createSite(t, a, 'https://other.example.com');
    const recrawl = async (siteId: string, sourceId: string): Promise<Response> => {
      await setStatus(t.env.DB, sourceId, 'ready');
      return call(t, `/sites/${siteId}/sources/${sourceId}/recrawl`, { method: 'POST', cookie: a.cookie });
    };

    for (let i = 0; i < 6; i++) expect((await recrawl(site.id, crawl.id)).status).toBe(200);
    const jobsBefore = t.queue.sent.length;
    const blocked = await recrawl(site.id, crawl.id);
    expect(blocked.status).toBe(429);
    const body = await json<ApiError>(blocked);
    expect(body.code).toBe('rate_limited');
    expect(body.retryAfter).toBeGreaterThan(0);
    expect(t.queue.sent).toHaveLength(jobsBefore);
    const row = await t.env.DB.prepare('SELECT status FROM sources WHERE id = ?1').bind(crawl.id).first<{ status: string }>();
    expect(row?.status).toBe('ready');

    // The limit is per site.
    expect((await recrawl(other.site.id, other.crawl.id)).status).toBe(200);
  });
});

describe('tenant isolation for delete and re-crawl', () => {
  it('gives user B a 404 on all three routes and changes nothing of user A\'s', async () => {
    const t = makeEnv();
    const a = await signUp(t);
    const b = await signUp(t);
    const { site, crawl } = await createSite(t, a);
    const mine = await createSite(t, b, 'https://b.example.org');
    const upload = await addUpload(t, a, site.id);
    await setStatus(t.env.DB, crawl.id, 'ready');
    await seedChunks(t, site.id, crawl.id, 3);
    await seedChunks(t, site.id, upload.id, 2);
    await seedCrawlPages(t.env.DB, crawl.id, 2);
    const db = t.env.DB;

    const snapshot = async (): Promise<unknown> => ({
      site: await db.prepare('SELECT * FROM sites WHERE id = ?1').bind(site.id).first(),
      sources: (await db.prepare('SELECT * FROM sources WHERE site_id = ?1 ORDER BY id').bind(site.id).all()).results,
      chunks: (await db.prepare('SELECT id FROM chunks WHERE site_id = ?1 ORDER BY id').bind(site.id).all()).results,
      pages: await count(db, 'crawl_pages', 'source_id', crawl.id),
      vectors: vectorsOf(t, site.id).sort(),
      objects: await objectsOf(t, site.id),
      jobs: t.queue.sent.length,
    });
    const before = await snapshot();

    const attempts: [string, string][] = [
      ['DELETE', `/sites/${site.id}`],
      ['DELETE', `/sites/${site.id}/sources/${crawl.id}`],
      ['DELETE', `/sites/${site.id}/sources/${upload.id}`],
      ['POST', `/sites/${site.id}/sources/${crawl.id}/recrawl`],
      // A's source ids under B's own site must not resolve either.
      ['DELETE', `/sites/${mine.site.id}/sources/${crawl.id}`],
      ['DELETE', `/sites/${mine.site.id}/sources/${upload.id}`],
      ['POST', `/sites/${mine.site.id}/sources/${crawl.id}/recrawl`],
    ];
    const missing = await call(t, `/sites/${newId()}`, { method: 'DELETE', cookie: b.cookie });
    expect(missing.status).toBe(404);
    const missingBody = await missing.text();
    expect((JSON.parse(missingBody) as ApiError).code).toBe('not_found');
    for (const [method, path] of attempts) {
      const res = await call(t, path, { method, cookie: b.cookie });
      expect(res.status, `${method} ${path}`).toBe(404);
      // Byte-identical to a site that does not exist, so ids cannot be probed.
      expect(await res.text(), `${method} ${path}`).toBe(missingBody);
    }
    // Signed out, the same routes do not even reach the lookup.
    for (const [method, path] of attempts) {
      expect((await call(t, path, { method })).status, `${method} ${path}`).toBe(401);
    }

    expect(await snapshot()).toEqual(before);
    // B's own site was not harmed by the attempts made through it.
    expect((await call(t, `/sites/${mine.site.id}`, { cookie: b.cookie })).status).toBe(200);
    expect(await listSources(t, b, mine.site.id)).toHaveLength(1);

    // A can still do all three.
    expect((await call(t, `/sites/${site.id}/sources/${crawl.id}/recrawl`, { method: 'POST', cookie: a.cookie })).status).toBe(200);
    expect((await call(t, `/sites/${site.id}/sources/${upload.id}`, { method: 'DELETE', cookie: a.cookie })).status).toBe(200);
    expect((await call(t, `/sites/${site.id}`, { method: 'DELETE', cookie: a.cookie })).status).toBe(200);
  });
});
