import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import {
  LIMITS,
  type ApiError,
  type ConversationSummary,
  type Message,
  type Site,
  type SiteUsage,
  type Source,
  type User,
} from '@sitebot/shared';
import { api } from '../src/api';
import type { Env } from '../src/env';
import { newId, sha256Hex } from '../src/util';
import { makeEnv, type TestEnv } from './helpers';

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

// Signup is rate limited per IP, so every test account comes from its own address.
const uniqueIp = (): string => `test-ip-${newId()}`;
const uniqueEmail = (): string => `${newId()}@example.com`;
const PASSWORD = 'a-long-enough-password';

interface Account {
  user: User;
  email: string;
  token: string;
  cookie: string;
}

function sessionToken(res: Response): string {
  const match = /sb_session=([^;]*)/.exec(res.headers.get('set-cookie') ?? '');
  return match?.[1] ?? '';
}

async function signUp(t: TestEnv, email = uniqueEmail()): Promise<Account> {
  const res = await call(t, '/auth/signup', { json: { email, password: PASSWORD }, ip: uniqueIp() });
  expect(res.status).toBe(200);
  const token = sessionToken(res);
  return { user: (await json<{ user: User }>(res)).user, email, token, cookie: `sb_session=${token}` };
}

async function createSite(t: TestEnv, account: Account, url = 'https://example.com'): Promise<Site> {
  const res = await call(t, '/sites', { json: { name: 'My Site', url }, cookie: account.cookie });
  expect(res.status).toBe(200);
  return (await json<{ site: Site }>(res)).site;
}

function uploadForm(name: string, content: string | Uint8Array, type = 'text/plain'): FormData {
  const form = new FormData();
  form.append('file', new File([content], name, { type }));
  return form;
}

async function seedConversation(
  db: D1Database,
  siteId: string,
  updatedAt: number,
  messages: { role: 'user' | 'assistant'; content: string; sources?: string }[],
): Promise<string> {
  const id = newId();
  await db.batch([
    db
      .prepare('INSERT INTO conversations (id, site_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4)')
      .bind(id, siteId, updatedAt - 1000, updatedAt),
    ...messages.map((m, i) =>
      db
        .prepare(
          `INSERT INTO messages (id, conversation_id, site_id, role, content, sources, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
        )
        .bind(newId(), id, siteId, m.role, m.content, m.sources ?? '[]', updatedAt - 1000 + i),
    ),
  ]);
  return id;
}

const sourceCount = async (db: D1Database, siteId: string): Promise<number> =>
  (await db.prepare('SELECT COUNT(*) AS n FROM sources WHERE site_id = ?1').bind(siteId).first<{ n: number }>())?.n ?? 0;

describe('auth routes', () => {
  it('signup sets an HttpOnly session cookie that /auth/me accepts', async () => {
    const t = makeEnv();
    const email = uniqueEmail();
    const res = await call(t, '/auth/signup', {
      json: { email: `  ${email.toUpperCase()} `, password: PASSWORD },
      ip: uniqueIp(),
    });
    expect(res.status).toBe(200);
    const { user } = await json<{ user: User }>(res);
    expect(user.email).toBe(email);

    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/^sb_session=[0-9a-f]{64};/);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).toContain(`Max-Age=${30 * 24 * 60 * 60}`);

    const me = await call(t, '/auth/me', { cookie: `sb_session=${sessionToken(res)}` });
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({ user: { id: user.id, email } });
  });

  it('stores only the hash of the session token, and a hashed password', async () => {
    const t = makeEnv();
    const a = await signUp(t);
    const sessions = await t.env.DB.prepare('SELECT id, expires_at FROM sessions WHERE user_id = ?1')
      .bind(a.user.id)
      .all<{ id: string; expires_at: number }>();
    expect(sessions.results).toHaveLength(1);
    const session = sessions.results[0];
    expect(session?.id).not.toBe(a.token);
    expect(session?.id).toBe(await sha256Hex(a.token));
    const days = ((session?.expires_at ?? 0) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThanOrEqual(30);

    const row = await t.env.DB.prepare('SELECT password_hash FROM users WHERE id = ?1')
      .bind(a.user.id)
      .first<{ password_hash: string }>();
    expect(row?.password_hash).toMatch(/^pbkdf2\$100000\$/);
    expect(row?.password_hash).not.toContain(PASSWORD);
  });

  it('rejects bad signup input and malformed JSON with 400, never 500', async () => {
    const t = makeEnv();
    const bad: unknown[] = [
      { email: 'not-an-email', password: PASSWORD },
      { email: `${'a'.repeat(250)}@example.com`, password: PASSWORD },
      { email: uniqueEmail(), password: 'short' },
      { email: uniqueEmail(), password: 'x'.repeat(201) },
      { email: uniqueEmail() },
      { email: 42, password: PASSWORD },
      [],
      'text',
    ];
    for (const body of bad) {
      const res = await call(t, '/auth/signup', { json: body, ip: uniqueIp() });
      expect(res.status).toBe(400);
      expect((await json<ApiError>(res)).code).toBe('invalid');
    }
    for (const path of ['/auth/signup', '/auth/login']) {
      const res = await call(t, path, { body: '{not json', ip: uniqueIp() });
      expect(res.status).toBe(400);
      expect((await json<ApiError>(res)).code).toBe('invalid');
    }
  });

  it('refuses a duplicate email with 409', async () => {
    const t = makeEnv();
    const a = await signUp(t);
    const res = await call(t, '/auth/signup', {
      json: { email: a.email.toUpperCase(), password: 'another-password' },
      ip: uniqueIp(),
    });
    expect(res.status).toBe(409);
    expect((await json<ApiError>(res)).code).toBe('conflict');
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('login works, and wrong password and unknown email fail identically', async () => {
    const t = makeEnv();
    const a = await signUp(t);

    const good = await call(t, '/auth/login', { json: { email: a.email, password: PASSWORD }, ip: uniqueIp() });
    expect(good.status).toBe(200);
    expect(await good.json()).toEqual({ user: a.user });
    const me = await call(t, '/auth/me', { cookie: `sb_session=${sessionToken(good)}` });
    expect(me.status).toBe(200);

    const wrongPassword = await call(t, '/auth/login', {
      json: { email: a.email, password: 'wrong-password' },
      ip: uniqueIp(),
    });
    const unknownEmail = await call(t, '/auth/login', {
      json: { email: uniqueEmail(), password: PASSWORD },
      ip: uniqueIp(),
    });
    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    expect(wrongPassword.headers.get('set-cookie')).toBeNull();
    const body = await wrongPassword.text();
    expect(await unknownEmail.text()).toBe(body);
    expect((JSON.parse(body) as ApiError).code).toBe('unauthorized');
  });

  it('logout invalidates the session', async () => {
    const t = makeEnv();
    const a = await signUp(t);
    const out = await call(t, '/auth/logout', { method: 'POST', cookie: a.cookie });
    expect(out.status).toBe(200);
    expect(await out.json()).toEqual({ ok: true });
    expect(out.headers.get('set-cookie')).toMatch(/^sb_session=;.*Max-Age=0/);

    // The old token is dead even if a client keeps sending it.
    expect((await call(t, '/auth/me', { cookie: a.cookie })).status).toBe(401);
    const left = await t.env.DB.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?1')
      .bind(a.user.id)
      .first<{ n: number }>();
    expect(left?.n).toBe(0);
  });

  it('rejects missing, unknown, and expired sessions with 401', async () => {
    const t = makeEnv();
    for (const cookie of [undefined, 'sb_session=', `sb_session=${'0'.repeat(64)}`]) {
      for (const path of ['/sites', '/auth/me']) {
        const res = await call(t, path, { cookie });
        expect(res.status).toBe(401);
        expect((await json<ApiError>(res)).code).toBe('unauthorized');
      }
    }
    expect((await call(t, '/auth/logout', { method: 'POST' })).status).toBe(401);

    const a = await signUp(t);
    await t.env.DB.prepare('UPDATE sessions SET expires_at = ?1 WHERE user_id = ?2')
      .bind(Date.now() - 1, a.user.id)
      .run();
    expect((await call(t, '/sites', { cookie: a.cookie })).status).toBe(401);
  });

  it('rate limits signup to 5 per hour per IP', async () => {
    const t = makeEnv();
    const ip = uniqueIp();
    for (let i = 0; i < 5; i++) {
      const res = await call(t, '/auth/signup', { json: { email: uniqueEmail(), password: PASSWORD }, ip });
      expect(res.status).toBe(200);
    }
    const email = uniqueEmail();
    const blocked = await call(t, '/auth/signup', { json: { email, password: PASSWORD }, ip });
    expect(blocked.status).toBe(429);
    const body = await json<ApiError>(blocked);
    expect(body.code).toBe('rate_limited');
    expect(body.retryAfter).toBeGreaterThan(0);
    expect(body.retryAfter).toBeLessThanOrEqual(3600);
    expect(blocked.headers.get('retry-after')).toBe(String(body.retryAfter));
    const created = await t.env.DB.prepare('SELECT id FROM users WHERE email = ?1').bind(email).first();
    expect(created).toBeNull();

    // Another address is unaffected.
    const other = await call(t, '/auth/signup', { json: { email: uniqueEmail(), password: PASSWORD }, ip: uniqueIp() });
    expect(other.status).toBe(200);
  });

  it('rate limits login to 10 per 5 minutes per IP', async () => {
    const t = makeEnv();
    const ip = uniqueIp();
    const attempt = { json: { email: uniqueEmail(), password: PASSWORD }, ip };
    for (let i = 0; i < 10; i++) expect((await call(t, '/auth/login', attempt)).status).toBe(401);
    const blocked = await call(t, '/auth/login', attempt);
    expect(blocked.status).toBe(429);
    expect((await json<ApiError>(blocked)).code).toBe('rate_limited');
  });
});

describe('origin guard', () => {
  it('refuses writes from a foreign Origin and allows the dashboard and same origin', async () => {
    const t = makeEnv();
    const signup = (origin?: string): Promise<Response> =>
      call(t, '/auth/signup', { json: { email: uniqueEmail(), password: PASSWORD }, ip: uniqueIp(), origin });

    for (const origin of ['https://evil.example', 'http://localhost:5173.evil.example', 'null']) {
      const res = await signup(origin);
      expect(res.status).toBe(403);
      expect((await json<ApiError>(res)).code).toBe('forbidden_origin');
    }
    expect((await signup('http://localhost:5173')).status).toBe(200);
    // api.request() serves from http://localhost, so this is the same-origin case.
    expect((await signup('http://localhost')).status).toBe(200);
    expect((await signup()).status).toBe(200);
  });

  it('accepts every origin listed in DASHBOARD_ORIGIN', async () => {
    const t = makeEnv({ DASHBOARD_ORIGIN: 'https://app.example.com, https://staging.example.com/' });
    const signup = (origin: string): Promise<Response> =>
      call(t, '/auth/signup', { json: { email: uniqueEmail(), password: PASSWORD }, ip: uniqueIp(), origin });
    expect((await signup('https://app.example.com')).status).toBe(200);
    expect((await signup('https://staging.example.com')).status).toBe(200);
    expect((await signup('http://localhost:5173')).status).toBe(403);
  });

  it('guards authenticated writes too, but not reads', async () => {
    const t = makeEnv();
    const a = await signUp(t);
    const site = await createSite(t, a);
    const before = t.queue.sent.length;

    const write = await call(t, `/sites/${site.id}`, {
      method: 'PATCH',
      json: { name: 'Hijacked' },
      cookie: a.cookie,
      origin: 'https://evil.example',
    });
    expect(write.status).toBe(403);
    const qa = await call(t, `/sites/${site.id}/sources/qa`, {
      json: { question: 'q', answer: 'a' },
      cookie: a.cookie,
      origin: 'https://evil.example',
    });
    expect(qa.status).toBe(403);
    expect(t.queue.sent).toHaveLength(before);

    const read = await call(t, `/sites/${site.id}`, { cookie: a.cookie, origin: 'https://evil.example' });
    expect(read.status).toBe(200);
    expect((await json<{ site: Site }>(read)).site.name).toBe('My Site');
  });
});

describe('sites', () => {
  it('creates a site with a pending crawl source and enqueues exactly one crawl job', async () => {
    const t = makeEnv();
    const a = await signUp(t);
    const res = await call(t, '/sites', {
      json: { name: '  Docs  ', url: 'https://www.Example.com/docs#intro' },
      cookie: a.cookie,
    });
    expect(res.status).toBe(200);
    const { site } = await json<{ site: Site }>(res);
    expect(site).toMatchObject({
      name: 'Docs',
      domains: ['example.com'],
      color: '#2563eb',
      position: 'right',
      instructions: '',
      monthlyCap: 1000,
    });
    expect(site.publicKey).toMatch(/^pk_[0-9a-f]{32}$/);
    expect(Math.abs(site.createdAt - Date.now())).toBeLessThan(60_000);

    const row = await t.env.DB.prepare('SELECT user_id FROM sites WHERE id = ?1').bind(site.id).first<{ user_id: string }>();
    expect(row?.user_id).toBe(a.user.id);

    const list = await call(t, `/sites/${site.id}/sources`, { cookie: a.cookie });
    const { sources } = await json<{ sources: Source[] }>(list);
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({
      siteId: site.id,
      kind: 'crawl',
      label: 'https://www.example.com/docs',
      status: 'pending',
      error: null,
      pages: 0,
    });
    expect(t.queue.sent).toEqual([{ type: 'crawl', siteId: site.id, sourceId: sources[0]?.id }]);
  });

  it('rejects unsafe URLs and bad names without creating anything', async () => {
    const t = makeEnv();
    const a = await signUp(t);
    const unsafe = [
      'http://localhost',
      'http://192.168.1.1',
      'http://169.254.169.254',
      'ftp://example.com',
      'http://127.0.0.1:8787',
      'http://[::1]/',
      'https://user:pw@example.com',
      'https://intranet',
      'not a url',
      '',
    ];
    for (const url of unsafe) {
      const res = await call(t, '/sites', { json: { name: 'Site', url }, cookie: a.cookie });
      expect(res.status, url).toBe(400);
      expect((await json<ApiError>(res)).code).toBe('invalid');
    }
    for (const name of ['', '   ', 'x'.repeat(81), 7]) {
      const res = await call(t, '/sites', { json: { name, url: 'https://example.com' }, cookie: a.cookie });
      expect(res.status).toBe(400);
    }
    const bad = await call(t, '/sites', { body: 'nope', cookie: a.cookie });
    expect(bad.status).toBe(400);

    const { sites } = await json<{ sites: Site[] }>(await call(t, '/sites', { cookie: a.cookie }));
    expect(sites).toEqual([]);
    expect(t.queue.sent).toEqual([]);
  });

  it('lists only the signed-in user\'s sites, newest first', async () => {
    const t = makeEnv();
    const a = await signUp(t);
    const b = await signUp(t);
    const first = await createSite(t, a, 'https://first.example.com');
    const second = await createSite(t, a, 'https://second.example.com');
    await createSite(t, b, 'https://other.example.com');
    // Same-millisecond inserts would tie; pin the order the test asserts.
    await t.env.DB.prepare('UPDATE sites SET created_at = created_at - 5000 WHERE id = ?1').bind(first.id).run();

    const { sites } = await json<{ sites: Site[] }>(await call(t, '/sites', { cookie: a.cookie }));
    expect(sites.map((s) => s.id)).toEqual([second.id, first.id]);
  });

  it('caps a user at 10 sites', async () => {
    const t = makeEnv();
    const a = await signUp(t);
    for (let i = 0; i < 10; i++) await createSite(t, a, `https://site${i}.example.com`);
    const res = await call(t, '/sites', { json: { name: 'Eleven', url: 'https://example.com' }, cookie: a.cookie });
    expect(res.status).toBe(400);
    const body = await json<ApiError>(res);
    expect(body.code).toBe('invalid');
    expect(body.error).toContain('10');
    expect(t.queue.sent).toHaveLength(10);
  });

  it('returns the site with this month\'s usage', async () => {
    const t = makeEnv();
    const a = await signUp(t);
    const site = await createSite(t, a);
    const today = new Date().toISOString().slice(0, 10);
    await t.env.DB.prepare(
      `INSERT INTO usage_daily (site_id, day, messages, prompt_tokens, completion_tokens, cached_tokens)
       VALUES (?1, ?2, 3, 300, 60, 150), (?1, '2020-01-01', 9, 9, 9, 9)`,
    )
      .bind(site.id, today)
      .run();

    const res = await call(t, `/sites/${site.id}`, { cookie: a.cookie });
    expect(res.status).toBe(200);
    const body = await json<{ site: Site; usage: SiteUsage }>(res);
    expect(body.site).toEqual(site);
    expect(body.usage).toEqual({
      month: today.slice(0, 7),
      messages: 3,
      promptTokens: 300,
      completionTokens: 60,
      cachedTokens: 150,
      cap: 1000,
    });
    expect((await call(t, `/sites/${newId()}`, { cookie: a.cookie })).status).toBe(404);
  });

  it('PATCH updates the editable fields', async () => {
    const t = makeEnv();
    const a = await signUp(t);
    const site = await createSite(t, a);
    const res = await call(t, `/sites/${site.id}`, {
      method: 'PATCH',
      json: {
        name: ' Renamed ',
        greeting: 'Hello there',
        instructions: 'Be brief.',
        color: '#A1b2C3',
        position: 'left',
        domains: ['Example.com', 'docs.example.org', 'localhost', 'example.com'],
      },
      cookie: a.cookie,
    });
    expect(res.status).toBe(200);
    const updated = (await json<{ site: Site }>(res)).site;
    expect(updated).toEqual({
      ...site,
      name: 'Renamed',
      greeting: 'Hello there',
      instructions: 'Be brief.',
      color: '#A1b2C3',
      position: 'left',
      domains: ['example.com', 'docs.example.org', 'localhost'],
    });

    // A partial update leaves the other fields alone.
    const partial = await call(t, `/sites/${site.id}`, { method: 'PATCH', json: { instructions: '' }, cookie: a.cookie });
    expect((await json<{ site: Site }>(partial)).site).toEqual({ ...updated, instructions: '' });
  });

  it('PATCH validates each field and changes nothing on failure', async () => {
    const t = makeEnv();
    const a = await signUp(t);
    const site = await createSite(t, a);
    const bad: Record<string, unknown>[] = [
      { color: 'red' },
      { color: '#12345' },
      { color: '#2563eb; background: url(x)' },
      { domains: ['https://example.com'] },
      { domains: ['example.com/path'] },
      { domains: ['example.com:8080'] },
      { domains: ['com'] },
      { domains: ['exa mple.com'] },
      { domains: ['*.example.com'] },
      { domains: [] },
      { domains: 'example.com' },
      { domains: [42] },
      { domains: Array.from({ length: 11 }, (_, i) => `d${i}.example.com`) },
      { greeting: 'x'.repeat(201) },
      { greeting: '   ' },
      { instructions: 'x'.repeat(2001) },
      { name: '' },
      { name: 'x'.repeat(81) },
      { position: 'top' },
      // One bad field fails the whole request, including the valid part.
      { name: 'Valid Name', color: 'nope' },
    ];
    for (const body of bad) {
      const res = await call(t, `/sites/${site.id}`, { method: 'PATCH', json: body, cookie: a.cookie });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await json<ApiError>(res)).code).toBe('invalid');
    }
    const malformed = await call(t, `/sites/${site.id}`, { method: 'PATCH', body: '{', cookie: a.cookie });
    expect(malformed.status).toBe(400);

    const after = await json<{ site: Site }>(await call(t, `/sites/${site.id}`, { cookie: a.cookie }));
    expect(after.site).toEqual(site);
  });

  it('PATCH sets and clears the brand look, validates it, and locks it against re-detection', async () => {
    const t = makeEnv();
    const a = await signUp(t);
    const site = await createSite(t, a);
    const patch = (body: unknown) =>
      call(t, `/sites/${site.id}`, { method: 'PATCH', json: body, cookie: a.cookie });
    const locked = async () =>
      (await t.env.DB.prepare('SELECT brand_locked FROM sites WHERE id = ?1').bind(site.id).first<{ brand_locked: number }>())
        ?.brand_locked;

    expect(site).toMatchObject({ background: null, textColor: null, font: null, logoUrl: null });
    await patch({ name: 'Renamed' });
    expect(await locked()).toBe(0);

    const res = await patch({
      background: '#060A08',
      textColor: '#ffffff',
      font: ' Space Grotesk ',
      logoUrl: 'https://example.com/logo.svg',
    });
    expect(res.status).toBe(200);
    expect((await json<{ site: Site }>(res)).site).toMatchObject({
      background: '#060A08',
      textColor: '#ffffff',
      font: 'Space Grotesk',
      logoUrl: 'https://example.com/logo.svg',
    });
    expect(await locked()).toBe(1);

    const cleared = await json<{ site: Site }>(await patch({ background: null, font: '', logoUrl: null }));
    expect(cleared.site).toMatchObject({ background: null, textColor: '#ffffff', font: null, logoUrl: null });

    for (const bad of [
      { background: 'red' },
      { textColor: '#fff' },
      { font: 'Inter; } body { display: none' },
      { font: 'url(https://evil.example/x)' },
      { logoUrl: 'http://example.com/logo.png' },
      { logoUrl: 'https://192.168.1.1/logo.png' },
      { logoUrl: 'javascript:alert(1)' },
      { logoUrl: 42 },
    ]) {
      expect((await patch(bad)).status, JSON.stringify(bad)).toBe(400);
    }
  });

  it('PATCH ignores monthlyCap, model, publicKey and other unknown fields', async () => {
    const t = makeEnv();
    const a = await signUp(t);
    const site = await createSite(t, a);
    const res = await call(t, `/sites/${site.id}`, {
      method: 'PATCH',
      json: {
        name: 'Still Mine',
        monthlyCap: 999_999,
        monthly_cap: 999_999,
        model: 'some/expensive-model',
        publicKey: 'pk_attacker',
        public_key: 'pk_attacker',
        id: newId(),
        userId: newId(),
        user_id: newId(),
        createdAt: 1,
      },
      cookie: a.cookie,
    });
    expect(res.status).toBe(200);
    expect((await json<{ site: Site }>(res)).site).toEqual({ ...site, name: 'Still Mine' });

    const row = await t.env.DB.prepare(
      'SELECT user_id, public_key, model, monthly_cap, created_at FROM sites WHERE id = ?1',
    )
      .bind(site.id)
      .first();
    expect(row).toEqual({
      user_id: a.user.id,
      public_key: site.publicKey,
      model: null,
      monthly_cap: 1000,
      created_at: site.createdAt,
    });
  });
});

describe('sources', () => {
  it('adds a crawl source on the site\'s own domain and refuses foreign hosts', async () => {
    const t = makeEnv();
    const a = await signUp(t);
    const site = await createSite(t, a);
    const path = `/sites/${site.id}/sources/crawl`;

    const ok = await call(t, path, { json: { url: 'https://docs.example.com/guide#top' }, cookie: a.cookie });
    expect(ok.status).toBe(200);
    const { source } = await json<{ source: Source }>(ok);
    expect(source).toMatchObject({
      siteId: site.id,
      kind: 'crawl',
      label: 'https://docs.example.com/guide',
      status: 'pending',
    });
    expect(t.queue.sent).toHaveLength(2);
    expect(t.queue.sent[1]).toEqual({ type: 'crawl', siteId: site.id, sourceId: source.id });
    expect((await call(t, path, { json: { url: 'https://www.example.com' }, cookie: a.cookie })).status).toBe(200);

    const refused = [
      'https://evil.com',
      'https://notexample.com',
      'https://example.com.evil.com',
      'http://localhost',
      'http://10.0.0.1',
      'ftp://example.com',
      'https://example.com:8443',
    ];
    for (const url of refused) {
      const res = await call(t, path, { json: { url }, cookie: a.cookie });
      expect(res.status, url).toBe(400);
      expect((await json<ApiError>(res)).code).toBe('invalid');
    }
    expect((await call(t, path, { json: {}, cookie: a.cookie })).status).toBe(400);
    expect((await call(t, path, { body: 'x', cookie: a.cookie })).status).toBe(400);
    expect(t.queue.sent).toHaveLength(3);
    expect(await sourceCount(t.env.DB, site.id)).toBe(3);
  });

  it('stores a .txt upload in R2 and enqueues an upload job', async () => {
    const t = makeEnv();
    const a = await signUp(t);
    const site = await createSite(t, a);
    const res = await call(t, `/sites/${site.id}/sources/upload`, {
      body: uploadForm('My notes (v2)!.TXT', 'hello from the handbook'),
      cookie: a.cookie,
    });
    expect(res.status).toBe(200);
    const { source } = await json<{ source: Source }>(res);
    expect(source).toMatchObject({
      siteId: site.id,
      kind: 'upload',
      label: 'My_notes__v2__.txt',
      status: 'pending',
      pages: 0,
    });

    const row = await t.env.DB.prepare('SELECT r2_key FROM sources WHERE id = ?1')
      .bind(source.id)
      .first<{ r2_key: string }>();
    expect(row?.r2_key).toBe(`${site.id}/${source.id}/My_notes__v2__.txt`);
    const object = await t.env.UPLOADS.get(row?.r2_key ?? '');
    expect(await object?.text()).toBe('hello from the handbook');
    expect(object?.httpMetadata?.contentType).toBe('text/plain');
    expect(t.queue.sent.at(-1)).toEqual({ type: 'upload', siteId: site.id, sourceId: source.id });
    expect(t.queue.sent).toHaveLength(2);
  });

  it('sanitises and caps upload file names, keeping the extension', async () => {
    const t = makeEnv();
    const a = await signUp(t);
    const site = await createSite(t, a);
    const upload = async (name: string): Promise<string> => {
      const res = await call(t, `/sites/${site.id}/sources/upload`, { body: uploadForm(name, 'x'), cookie: a.cookie });
      expect(res.status).toBe(200);
      return (await json<{ source: Source }>(res)).source.label;
    };
    expect(await upload('../../etc/passwd.md')).toBe('.._.._etc_passwd.md');
    const long = await upload(`${'n'.repeat(300)}.pdf`);
    expect(long).toHaveLength(100);
    expect(long.endsWith('.pdf')).toBe(true);
    expect(await upload('résumé \u{1F600}.txt')).toMatch(/^[A-Za-z0-9._-]+\.txt$/);
  });

  it('rejects disallowed, empty, oversize, and missing uploads', async () => {
    const t = makeEnv();
    const a = await signUp(t);
    const site = await createSite(t, a);
    const path = `/sites/${site.id}/sources/upload`;
    const expectInvalid = async (init: CallInit): Promise<void> => {
      const res = await call(t, path, { ...init, cookie: a.cookie });
      expect(res.status).toBe(400);
      expect((await json<ApiError>(res)).code).toBe('invalid');
    };

    await expectInvalid({ body: uploadForm('setup.exe', 'MZ') });
    await expectInvalid({ body: uploadForm('notes.txt.exe', 'MZ') });
    await expectInvalid({ body: uploadForm('noextension', 'text') });
    await expectInvalid({ body: uploadForm('page.html', '<p>hi</p>') });
    await expectInvalid({ body: uploadForm('empty.txt', '') });
    await expectInvalid({ body: uploadForm('big.txt', new Uint8Array(LIMITS.uploadMaxBytes + 1)) });
    const noFile = new FormData();
    noFile.append('file', 'just a string');
    await expectInvalid({ body: noFile });
    await expectInvalid({ body: new FormData() });
    await expectInvalid({ json: { file: 'notes.txt' } });

    expect(await sourceCount(t.env.DB, site.id)).toBe(1);
    expect(t.queue.sent).toHaveLength(1);
    expect((await t.env.UPLOADS.list({ prefix: `${site.id}/` })).objects).toEqual([]);
  });

  it('accepts an upload of exactly the size limit', async () => {
    const t = makeEnv();
    const a = await signUp(t);
    const site = await createSite(t, a);
    const res = await call(t, `/sites/${site.id}/sources/upload`, {
      body: uploadForm('max.pdf', new Uint8Array(LIMITS.uploadMaxBytes), 'application/pdf'),
      cookie: a.cookie,
    });
    expect(res.status).toBe(200);
    const listed = await t.env.UPLOADS.list({ prefix: `${site.id}/` });
    expect(listed.objects.map((o) => o.size)).toEqual([LIMITS.uploadMaxBytes]);
  });

  it('creates a qa source and enqueues a qa job', async () => {
    const t = makeEnv();
    const a = await signUp(t);
    const site = await createSite(t, a);
    const path = `/sites/${site.id}/sources/qa`;
    const res = await call(t, path, {
      json: { question: '  What are your hours?  ', answer: '  9 to 5, Monday to Friday.  ' },
      cookie: a.cookie,
    });
    expect(res.status).toBe(200);
    const { source } = await json<{ source: Source }>(res);
    expect(source).toMatchObject({ siteId: site.id, kind: 'qa', label: 'What are your hours?', status: 'pending' });
    expect(source.createdAt).toBe(source.updatedAt);

    const row = await t.env.DB.prepare('SELECT content, r2_key FROM sources WHERE id = ?1').bind(source.id).first();
    expect(row).toEqual({ content: '9 to 5, Monday to Friday.', r2_key: null });
    expect(t.queue.sent.at(-1)).toEqual({ type: 'qa', siteId: site.id, sourceId: source.id });

    const bad: unknown[] = [
      { question: '', answer: 'a' },
      { question: 'q', answer: '   ' },
      { question: 'x'.repeat(301), answer: 'a' },
      { question: 'q', answer: 'x'.repeat(2001) },
      { question: 'q' },
      { question: 1, answer: 2 },
    ];
    for (const body of bad) {
      expect((await call(t, path, { json: body, cookie: a.cookie })).status).toBe(400);
    }
    expect(t.queue.sent).toHaveLength(2);

    const { sources } = await json<{ sources: Source[] }>(await call(t, `/sites/${site.id}/sources`, { cookie: a.cookie }));
    expect(sources.map((s) => s.kind).sort()).toEqual(['crawl', 'qa']);
  });

  it('caps a site at 50 sources across all three kinds', async () => {
    const t = makeEnv();
    const a = await signUp(t);
    const site = await createSite(t, a);
    const now = Date.now();
    await t.env.DB.batch(
      Array.from({ length: 49 }, (_, i) =>
        t.env.DB.prepare(
          `INSERT INTO sources (id, site_id, kind, label, content, created_at, updated_at)
           VALUES (?1, ?2, 'qa', ?3, 'a', ?4, ?4)`,
        ).bind(newId(), site.id, `q${i}`, now),
      ),
    );
    const base = `/sites/${site.id}/sources`;
    const attempts: CallInit[] = [
      { json: { question: 'q', answer: 'a' } },
      { json: { url: 'https://example.com/more' } },
      { body: uploadForm('notes.txt', 'text') },
    ];
    const paths = ['qa', 'crawl', 'upload'];
    for (const [i, init] of attempts.entries()) {
      const res = await call(t, `${base}/${paths[i]}`, { ...init, cookie: a.cookie });
      expect(res.status).toBe(400);
      expect((await json<ApiError>(res)).error).toContain('50');
    }
    expect(await sourceCount(t.env.DB, site.id)).toBe(50);
    expect(t.queue.sent).toHaveLength(1);
    expect((await t.env.UPLOADS.list({ prefix: `${site.id}/` })).objects).toEqual([]);
  });

  it('marks the source as failed when the job cannot be queued', async () => {
    const t = makeEnv();
    const a = await signUp(t);
    const site = await createSite(t, a);
    t.queue.send = async () => {
      throw new Error('queue down');
    };
    const res = await call(t, `/sites/${site.id}/sources/qa`, { json: { question: 'q', answer: 'a' }, cookie: a.cookie });
    expect(res.status).toBe(200);
    const { source } = await json<{ source: Source }>(res);
    expect(source.status).toBe('error');
    expect(source.error).toBeTruthy();
  });
});

describe('conversations', () => {
  it('lists conversations newest first with a count and a truncated preview', async () => {
    const t = makeEnv();
    const a = await signUp(t);
    const site = await createSite(t, a);
    const now = Date.now();
    const longQuestion = `How do I ${'really '.repeat(40)}reset my password?`;
    const older = await seedConversation(t.env.DB, site.id, now - 60_000, [
      { role: 'user', content: longQuestion },
      { role: 'assistant', content: 'Use the reset link.' },
      { role: 'user', content: 'Thanks' },
    ]);
    const newer = await seedConversation(t.env.DB, site.id, now, [
      // A greeting stored first must not become the preview: it is not a visitor message.
      { role: 'assistant', content: 'Hi! Ask me anything.' },
      { role: 'user', content: 'Do you ship abroad?' },
    ]);
    const empty = await seedConversation(t.env.DB, site.id, now - 120_000, []);

    const res = await call(t, `/sites/${site.id}/conversations`, { cookie: a.cookie });
    expect(res.status).toBe(200);
    const { conversations } = await json<{ conversations: ConversationSummary[] }>(res);
    expect(conversations).toEqual([
      { id: newer, createdAt: now - 1000, updatedAt: now, messageCount: 2, preview: 'Do you ship abroad?' },
      {
        id: older,
        createdAt: now - 61_000,
        updatedAt: now - 60_000,
        messageCount: 3,
        preview: longQuestion.slice(0, 120),
      },
      { id: empty, createdAt: now - 121_000, updatedAt: now - 120_000, messageCount: 0, preview: '' },
    ]);
    expect(conversations[1]?.preview).toHaveLength(120);
  });

  it('returns at most the latest 50 conversations', async () => {
    const t = makeEnv();
    const a = await signUp(t);
    const site = await createSite(t, a);
    const now = Date.now();
    await t.env.DB.batch(
      Array.from({ length: 55 }, (_, i) =>
        t.env.DB.prepare('INSERT INTO conversations (id, site_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)').bind(
          `${site.id}-c${i}`,
          site.id,
          now + i,
        ),
      ),
    );
    const { conversations } = await json<{ conversations: ConversationSummary[] }>(
      await call(t, `/sites/${site.id}/conversations`, { cookie: a.cookie }),
    );
    expect(conversations).toHaveLength(50);
    expect(conversations[0]?.id).toBe(`${site.id}-c54`);
    expect(conversations[49]?.id).toBe(`${site.id}-c5`);
  });

  it('returns messages oldest first with parsed sources', async () => {
    const t = makeEnv();
    const a = await signUp(t);
    const site = await createSite(t, a);
    const links = [{ url: 'https://example.com/shipping', title: 'Shipping' }];
    const cid = await seedConversation(t.env.DB, site.id, Date.now(), [
      { role: 'user', content: 'Do you ship abroad?' },
      { role: 'assistant', content: 'Yes, worldwide.', sources: JSON.stringify(links) },
      { role: 'user', content: 'Great' },
      { role: 'assistant', content: 'Anything else?', sources: 'not json' },
    ]);

    const res = await call(t, `/sites/${site.id}/conversations/${cid}`, { cookie: a.cookie });
    expect(res.status).toBe(200);
    const { messages } = await json<{ messages: Message[] }>(res);
    expect(messages.map((m) => [m.role, m.content, m.sources])).toEqual([
      ['user', 'Do you ship abroad?', []],
      ['assistant', 'Yes, worldwide.', links],
      ['user', 'Great', []],
      ['assistant', 'Anything else?', []],
    ]);
    expect(messages.map((m) => m.createdAt)).toEqual([...messages.map((m) => m.createdAt)].sort((x, y) => x - y));
    expect(messages.every((m) => typeof m.id === 'string' && m.id.length > 0)).toBe(true);
  });

  it('refuses a conversation id that belongs to another site, even one the user owns', async () => {
    const t = makeEnv();
    const a = await signUp(t);
    const siteOne = await createSite(t, a, 'https://one.example.com');
    const siteTwo = await createSite(t, a, 'https://two.example.com');
    const cid = await seedConversation(t.env.DB, siteOne.id, Date.now(), [{ role: 'user', content: 'private to one' }]);

    expect((await call(t, `/sites/${siteOne.id}/conversations/${cid}`, { cookie: a.cookie })).status).toBe(200);
    const res = await call(t, `/sites/${siteTwo.id}/conversations/${cid}`, { cookie: a.cookie });
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('private to one');
    expect((await call(t, `/sites/${siteOne.id}/conversations/${newId()}`, { cookie: a.cookie })).status).toBe(404);

    const list = await json<{ conversations: ConversationSummary[] }>(
      await call(t, `/sites/${siteTwo.id}/conversations`, { cookie: a.cookie }),
    );
    expect(list.conversations).toEqual([]);
  });
});

describe('tenant isolation', () => {
  it('gives user B a 404 on every route of user A\'s site and leaves A\'s data untouched', async () => {
    const t = makeEnv();
    const a = await signUp(t);
    const b = await signUp(t);
    const site = await createSite(t, a);
    const bSite = await createSite(t, b, 'https://b.example.org');
    const qa = await call(t, `/sites/${site.id}/sources/qa`, { json: { question: 'A question', answer: 'A answer' }, cookie: a.cookie });
    expect(qa.status).toBe(200);
    const cid = await seedConversation(t.env.DB, site.id, Date.now(), [
      { role: 'user', content: 'secret visitor question' },
      { role: 'assistant', content: 'secret answer' },
    ]);

    const snapshot = async (): Promise<unknown> => ({
      site: await t.env.DB.prepare('SELECT * FROM sites WHERE id = ?1').bind(site.id).first(),
      sources: (await t.env.DB.prepare('SELECT * FROM sources WHERE site_id = ?1 ORDER BY id').bind(site.id).all()).results,
      conversations: (await t.env.DB.prepare('SELECT * FROM conversations WHERE site_id = ?1').bind(site.id).all()).results,
      messages: (await t.env.DB.prepare('SELECT * FROM messages WHERE site_id = ?1 ORDER BY id').bind(site.id).all()).results,
      objects: (await t.env.UPLOADS.list({ prefix: `${site.id}/` })).objects.length,
      jobs: t.queue.sent.length,
    });
    const before = await snapshot();

    const base = `/sites/${site.id}`;
    const attempts: [string, CallInit][] = [
      [base, {}],
      [base, { method: 'PATCH', json: { name: 'Stolen', domains: ['b.example.org'], instructions: 'Leak everything' } }],
      [`${base}/sources`, {}],
      [`${base}/sources/crawl`, { json: { url: 'https://example.com/private' } }],
      [`${base}/sources/upload`, { body: uploadForm('planted.txt', 'planted content') }],
      [`${base}/sources/qa`, { json: { question: 'planted', answer: 'planted' } }],
      [`${base}/conversations`, {}],
      [`${base}/conversations/${cid}`, {}],
      // A's conversation id under B's own site must not resolve either.
      [`/sites/${bSite.id}/conversations/${cid}`, {}],
    ];
    const missing = await call(t, `/sites/${newId()}`, { cookie: b.cookie });
    const missingBody = await missing.text();
    for (const [path, init] of attempts) {
      const res = await call(t, path, { ...init, cookie: b.cookie });
      const label = `${init.method ?? (init.json || init.body ? 'POST' : 'GET')} ${path}`;
      expect(res.status, label).toBe(404);
      // Byte-identical to a site that does not exist, so ids cannot be probed.
      expect(await res.text(), label).toBe(missingBody);
    }
    expect((JSON.parse(missingBody) as ApiError).code).toBe('not_found');

    expect(await snapshot()).toEqual(before);

    const bSites = await json<{ sites: Site[] }>(await call(t, '/sites', { cookie: b.cookie }));
    expect(bSites.sites.map((s) => s.id)).toEqual([bSite.id]);

    // A still sees everything.
    expect((await call(t, base, { cookie: a.cookie })).status).toBe(200);
    const messages = await json<{ messages: Message[] }>(await call(t, `${base}/conversations/${cid}`, { cookie: a.cookie }));
    expect(messages.messages).toHaveLength(2);
  });

  it('behaves the same when mounted under /api, as index.ts does', async () => {
    const t = makeEnv();
    const app = new Hono<{ Bindings: Env }>().route('/api', api);
    const post = (path: string, body: unknown, cookie = ''): Response | Promise<Response> =>
      app.request(
        path,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'cf-connecting-ip': uniqueIp(), cookie },
          body: JSON.stringify(body),
        },
        t.env,
      );

    const signup = await post('/api/auth/signup', { email: uniqueEmail(), password: PASSWORD });
    expect(signup.status).toBe(200);
    const cookie = `sb_session=${sessionToken(signup)}`;
    const created = await post('/api/sites', { name: 'Mounted', url: 'https://example.com' }, cookie);
    expect(created.status).toBe(200);
    const { site } = await json<{ site: Site }>(created);

    const get = (path: string, withCookie: boolean): Response | Promise<Response> =>
      app.request(path, { headers: withCookie ? { cookie } : {} }, t.env);
    expect((await get(`/api/sites/${site.id}`, true)).status).toBe(200);
    expect((await get(`/api/sites/${site.id}`, false)).status).toBe(401);
    expect((await get('/api/sites', false)).status).toBe(401);
    const unknown = await get('/api/nope', true);
    expect(unknown.status).toBe(404);
    expect((await json<ApiError>(unknown)).code).toBe('not_found');
  });

  it('answers unknown routes with a JSON 404 once signed in, and 401 when not', async () => {
    const t = makeEnv();
    const a = await signUp(t);
    const res = await call(t, '/nope', { cookie: a.cookie });
    expect(res.status).toBe(404);
    expect((await json<ApiError>(res)).code).toBe('not_found');
    expect((await call(t, '/nope')).status).toBe(401);
    // DELETE is not part of the contract.
    const site = await createSite(t, a);
    expect((await call(t, `/sites/${site.id}`, { method: 'DELETE', cookie: a.cookie })).status).toBe(404);
  });
});
