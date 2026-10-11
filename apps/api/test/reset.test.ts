import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiError, User } from '@sitebot/shared';
import { api } from '../src/api';
import type { Env } from '../src/env';
import { sendMail } from '../src/mail';
import { newId, randomToken, sha256Hex } from '../src/util';
import { makeEnv, type TestEnv } from './helpers';

interface CallInit {
  json?: unknown;
  body?: BodyInit;
  cookie?: string;
  ip?: string;
}

async function call(t: TestEnv, path: string, init: CallInit = {}): Promise<Response> {
  const headers = new Headers();
  if (init.json !== undefined) headers.set('content-type', 'application/json');
  if (init.cookie) headers.set('cookie', init.cookie);
  // Every route here is rate limited per IP, so each call comes from its own address by default.
  headers.set('cf-connecting-ip', init.ip ?? `test-ip-${newId()}`);
  const body = init.json !== undefined ? JSON.stringify(init.json) : init.body;
  return api.request(path, { method: body === undefined ? 'GET' : 'POST', headers, body }, t.env);
}

const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;

const OLD_PASSWORD = 'the-old-password';
const NEW_PASSWORD = 'a-brand-new-password';
const APP_URL = 'https://app.example.com';
const MAIL_ENV: Partial<Env> = {
  RESEND_API_KEY: 're_test_mail_key',
  MAIL_FROM: 'Sitebot <no-reply@example.com>',
  APP_URL,
};

interface Account {
  user: User;
  email: string;
  cookie: string;
}

const cookieOf = (res: Response): string => `sb_session=${/sb_session=([^;]*)/.exec(res.headers.get('set-cookie') ?? '')?.[1] ?? ''}`;

async function signUp(t: TestEnv): Promise<Account> {
  const email = `${newId()}@example.com`;
  const res = await call(t, '/auth/signup', { json: { email, password: OLD_PASSWORD } });
  expect(res.status).toBe(200);
  return { user: (await json<{ user: User }>(res)).user, email, cookie: cookieOf(res) };
}

const login = (t: TestEnv, email: string, password: string): Promise<Response> =>
  call(t, '/auth/login', { json: { email, password } });

interface ResetRow {
  id: string;
  user_id: string;
  expires_at: number;
  used_at: number | null;
}

const resetRows = async (db: D1Database, userId: string): Promise<ResetRow[]> =>
  (await db.prepare('SELECT * FROM password_resets WHERE user_id = ?1').bind(userId).all<ResetRow>()).results;

const totalResets = async (db: D1Database): Promise<number> =>
  (await db.prepare('SELECT COUNT(*) AS n FROM password_resets').first<{ n: number }>())?.n ?? 0;

const sessionCount = async (db: D1Database, userId: string): Promise<number> =>
  (await db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?1').bind(userId).first<{ n: number }>())?.n ?? 0;

/** Stores a reset row directly, as a request would, and returns the token that was "mailed". */
async function seedReset(db: D1Database, userId: string, expiresAt = Date.now() + 3_600_000): Promise<string> {
  const token = randomToken(32);
  await db
    .prepare('INSERT INTO password_resets (id, user_id, expires_at) VALUES (?1, ?2, ?3)')
    .bind(await sha256Hex(token), userId, expiresAt)
    .run();
  return token;
}

interface SentMail {
  url: string;
  authorization: string | null;
  body: { from: string; to: string[]; subject: string; text: string };
}

/** Stands in for Resend and records what was sent to it. */
function mockMail(status = 200): SentMail[] {
  const sent: SentMail[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    sent.push({
      url: String(input),
      authorization: new Headers(init?.headers).get('authorization'),
      body: JSON.parse(init?.body as string) as SentMail['body'],
    });
    return new Response('{"id":"mail_1"}', { status });
  });
  return sent;
}

const tokenIn = (text: string): string => /#\/reset\/([0-9a-f]+)/.exec(text)?.[1] ?? '';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /auth/reset/request', () => {
  it('answers ok for an unknown email, stores nothing, and sends no mail', async () => {
    const t = makeEnv(MAIL_ENV);
    const sent = mockMail();
    const before = await totalResets(t.env.DB);

    const res = await call(t, '/auth/reset/request', { json: { email: `${newId()}@example.com` } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await totalResets(t.env.DB)).toBe(before);
    expect(sent).toEqual([]);
  });

  it('stores only the token hash and mails the link to the account address', async () => {
    const t = makeEnv(MAIL_ENV);
    const a = await signUp(t);
    const sent = mockMail();

    // The address is matched the way signup stores it.
    const res = await call(t, '/auth/reset/request', { json: { email: `  ${a.email.toUpperCase()} ` } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get('set-cookie')).toBeNull();

    expect(sent).toHaveLength(1);
    const mail = sent[0]!;
    expect(mail.url).toBe('https://api.resend.com/emails');
    expect(mail.authorization).toBe('Bearer re_test_mail_key');
    expect(mail.body.from).toBe('Sitebot <no-reply@example.com>');
    expect(mail.body.to).toEqual([a.email]);
    expect(mail.body.subject).not.toBe('');
    const token = tokenIn(mail.body.text);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(mail.body.text).toContain(`${APP_URL}/#/reset/${token}`);
    expect(mail.body.text).toContain('60 minutes');

    const rows = await resetRows(t.env.DB, a.user.id);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.id).toBe(await sha256Hex(token));
    expect(row.id).not.toBe(token);
    expect(JSON.stringify(row)).not.toContain(token);
    expect(row.used_at).toBeNull();
    const minutes = (row.expires_at - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(59.5);
    expect(minutes).toBeLessThanOrEqual(60);
  });

  it('answers a known and an unknown address identically', async () => {
    const t = makeEnv(MAIL_ENV);
    const a = await signUp(t);
    mockMail();
    const known = await call(t, '/auth/reset/request', { json: { email: a.email } });
    const unknown = await call(t, '/auth/reset/request', { json: { email: `${newId()}@example.com` } });
    expect(known.status).toBe(unknown.status);
    expect(await known.text()).toBe(await unknown.text());
    expect([...known.headers.keys()].sort()).toEqual([...unknown.headers.keys()].sort());
  });

  it('does the lookup and the mail after the response when the runtime can defer work', async () => {
    const t = makeEnv(MAIL_ENV);
    const a = await signUp(t);
    const sent = mockMail();
    const deferred: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (work: Promise<unknown>): void => void deferred.push(work),
      passThroughOnException: (): void => {},
    } as unknown as ExecutionContext;
    const request = (email: string): Response | Promise<Response> =>
      api.request(
        '/auth/reset/request',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'cf-connecting-ip': `test-ip-${newId()}` },
          body: JSON.stringify({ email }),
        },
        t.env,
        ctx,
      );

    // Known and unknown addresses hand off exactly one piece of work each, so neither answers sooner.
    expect(await (await request(a.email)).json()).toEqual({ ok: true });
    expect(await (await request(`${newId()}@example.com`)).json()).toEqual({ ok: true });
    expect(deferred).toHaveLength(2);
    await Promise.all(deferred);
    expect(sent.map((m) => m.body.to)).toEqual([[a.email]]);
    expect(await resetRows(t.env.DB, a.user.id)).toHaveLength(1);
  });

  it('still answers ok when the mail provider fails', async () => {
    const t = makeEnv(MAIL_ENV);
    const a = await signUp(t);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const sent = mockMail(500);
    const res = await call(t, '/auth/reset/request', { json: { email: a.email } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(sent).toHaveLength(1);
    // Neither the key, the address, nor the link ends up in a log line.
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).not.toContain('re_test_mail_key');
    expect(logged).not.toContain(a.email);
    expect(logged).not.toContain(tokenIn(sent[0]!.body.text));
  });

  it('a new request replaces the earlier link', async () => {
    const t = makeEnv(MAIL_ENV);
    const a = await signUp(t);
    const sent = mockMail();
    await call(t, '/auth/reset/request', { json: { email: a.email } });
    await call(t, '/auth/reset/request', { json: { email: a.email } });
    expect(sent).toHaveLength(2);
    const [first, second] = sent.map((m) => tokenIn(m.body.text));
    expect(first).not.toBe(second);

    const rows = await resetRows(t.env.DB, a.user.id);
    expect(rows.map((r) => r.id)).toEqual([await sha256Hex(second!)]);
    const stale = await call(t, '/auth/reset/confirm', { json: { token: first, password: NEW_PASSWORD } });
    expect(stale.status).toBe(400);
    const fresh = await call(t, '/auth/reset/confirm', { json: { token: second, password: NEW_PASSWORD } });
    expect(fresh.status).toBe(200);
  });

  it('makes no request without mail config, but the row still exists', async () => {
    const partial: Partial<Env>[] = [
      {},
      { RESEND_API_KEY: 're_test_mail_key', APP_URL },
      { MAIL_FROM: 'Sitebot <no-reply@example.com>', APP_URL },
      // Without the dashboard address there is no link to put in a mail.
      { RESEND_API_KEY: 're_test_mail_key', MAIL_FROM: 'Sitebot <no-reply@example.com>' },
    ];
    for (const overrides of partial) {
      const t = makeEnv(overrides);
      const a = await signUp(t);
      const sent = mockMail();
      const res = await call(t, '/auth/reset/request', { json: { email: a.email } });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(sent, JSON.stringify(Object.keys(overrides))).toEqual([]);
      expect(await resetRows(t.env.DB, a.user.id)).toHaveLength(1);
      vi.restoreAllMocks();
    }
  });

  it('rejects a malformed body with 400', async () => {
    const t = makeEnv(MAIL_ENV);
    const sent = mockMail();
    for (const body of [{}, { email: 'not-an-email' }, { email: 42 }, [], 'text']) {
      const res = await call(t, '/auth/reset/request', { json: body });
      expect(res.status).toBe(400);
      expect((await json<ApiError>(res)).code).toBe('invalid');
    }
    expect((await call(t, '/auth/reset/request', { body: '{not json' })).status).toBe(400);
    expect(sent).toEqual([]);
  });

  it('is limited to 5 per hour per IP', async () => {
    const t = makeEnv(MAIL_ENV);
    const a = await signUp(t);
    const sent = mockMail();
    const ip = `test-ip-${newId()}`;
    for (let i = 0; i < 5; i++) {
      expect((await call(t, '/auth/reset/request', { json: { email: a.email }, ip })).status).toBe(200);
    }
    const blocked = await call(t, '/auth/reset/request', { json: { email: a.email }, ip });
    expect(blocked.status).toBe(429);
    const body = await json<ApiError>(blocked);
    expect(body.code).toBe('rate_limited');
    expect(body.retryAfter).toBeGreaterThan(0);
    expect(body.retryAfter).toBeLessThanOrEqual(3600);
    expect(blocked.headers.get('retry-after')).toBe(String(body.retryAfter));
    expect(sent).toHaveLength(5);

    // Another address is unaffected.
    expect((await call(t, '/auth/reset/request', { json: { email: a.email } })).status).toBe(200);
  });
});

describe('POST /auth/reset/confirm', () => {
  it('changes the password, signs out every device, and works only once', async () => {
    const t = makeEnv();
    const a = await signUp(t);
    const second = await login(t, a.email, OLD_PASSWORD);
    expect(second.status).toBe(200);
    expect(await sessionCount(t.env.DB, a.user.id)).toBe(2);
    const bystander = await signUp(t);
    const token = await seedReset(t.env.DB, a.user.id);

    const res = await call(t, '/auth/reset/confirm', { json: { token, password: NEW_PASSWORD } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    // The reset does not sign anyone in.
    expect(res.headers.get('set-cookie')).toBeNull();

    expect(await sessionCount(t.env.DB, a.user.id)).toBe(0);
    for (const cookie of [a.cookie, cookieOf(second)]) {
      expect((await call(t, '/auth/me', { cookie })).status).toBe(401);
    }
    expect((await login(t, a.email, OLD_PASSWORD)).status).toBe(401);
    const fresh = await login(t, a.email, NEW_PASSWORD);
    expect(fresh.status).toBe(200);
    expect((await call(t, '/auth/me', { cookie: cookieOf(fresh) })).status).toBe(200);

    const stored = await t.env.DB.prepare('SELECT password_hash FROM users WHERE id = ?1')
      .bind(a.user.id)
      .first<{ password_hash: string }>();
    expect(stored?.password_hash).toMatch(/^pbkdf2\$100000\$/);
    expect(stored?.password_hash).not.toContain(NEW_PASSWORD);

    // Spent: the same link cannot set another password.
    const rows = await resetRows(t.env.DB, a.user.id);
    expect(rows).toHaveLength(1);
    expect(Math.abs((rows[0]?.used_at ?? 0) - Date.now())).toBeLessThan(60_000);
    const again = await call(t, '/auth/reset/confirm', { json: { token, password: 'yet-another-password' } });
    expect(again.status).toBe(400);
    expect((await json<ApiError>(again)).code).toBe('invalid');
    expect((await login(t, a.email, 'yet-another-password')).status).toBe(401);
    expect((await login(t, a.email, NEW_PASSWORD)).status).toBe(200);

    // Nobody else was signed out or changed.
    expect((await call(t, '/auth/me', { cookie: bystander.cookie })).status).toBe(200);
    expect((await login(t, bystander.email, OLD_PASSWORD)).status).toBe(200);
  });

  it('lets only one of two simultaneous confirmations win', async () => {
    const t = makeEnv();
    const a = await signUp(t);
    const token = await seedReset(t.env.DB, a.user.id);
    const results = await Promise.all([
      call(t, '/auth/reset/confirm', { json: { token, password: 'first-new-password' } }),
      call(t, '/auth/reset/confirm', { json: { token, password: 'second-new-password' } }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
    const winner = results[0]?.status === 200 ? 'first-new-password' : 'second-new-password';
    const loser = results[0]?.status === 200 ? 'second-new-password' : 'first-new-password';
    expect((await login(t, a.email, winner)).status).toBe(200);
    expect((await login(t, a.email, loser)).status).toBe(401);
  });

  it('answers 400 with one generic message for an expired, wrong, or malformed token', async () => {
    const t = makeEnv();
    const a = await signUp(t);
    const expired = await seedReset(t.env.DB, a.user.id, Date.now() - 1);
    const bodies: string[] = [];
    for (const token of [expired, randomToken(32), 'not-a-token', '', 42, null, undefined, 'a'.repeat(5000)]) {
      const res = await call(t, '/auth/reset/confirm', { json: { token, password: NEW_PASSWORD } });
      expect(res.status, String(token).slice(0, 20)).toBe(400);
      bodies.push(await res.text());
    }
    expect(new Set(bodies).size).toBe(1);
    expect((JSON.parse(bodies[0]!) as ApiError).code).toBe('invalid');

    expect((await call(t, '/auth/reset/confirm', { body: '{not json' })).status).toBe(400);
    expect((await call(t, '/auth/reset/confirm', { json: [] })).status).toBe(400);

    // Nothing changed: the old password and the old session still work.
    expect((await login(t, a.email, OLD_PASSWORD)).status).toBe(200);
    expect((await call(t, '/auth/me', { cookie: a.cookie })).status).toBe(200);
    expect((await resetRows(t.env.DB, a.user.id))[0]?.used_at).toBeNull();
  });

  it('answers 400 for a password signup would refuse, and does not spend the token', async () => {
    const t = makeEnv();
    const a = await signUp(t);
    const token = await seedReset(t.env.DB, a.user.id);
    for (const password of ['short', 'x'.repeat(201), '', 12345678, undefined]) {
      const res = await call(t, '/auth/reset/confirm', { json: { token, password } });
      expect(res.status).toBe(400);
      const body = await json<ApiError>(res);
      expect(body.code).toBe('invalid');
      expect(body.error).toContain('8 to 200');
    }
    expect((await login(t, a.email, OLD_PASSWORD)).status).toBe(200);
    expect((await call(t, '/auth/me', { cookie: a.cookie })).status).toBe(200);

    const res = await call(t, '/auth/reset/confirm', { json: { token, password: NEW_PASSWORD } });
    expect(res.status).toBe(200);
    expect((await login(t, a.email, NEW_PASSWORD)).status).toBe(200);
  });

  it('is limited to 10 per hour per IP', async () => {
    const t = makeEnv();
    const a = await signUp(t);
    const token = await seedReset(t.env.DB, a.user.id);
    const ip = `test-ip-${newId()}`;
    for (let i = 0; i < 10; i++) {
      const res = await call(t, '/auth/reset/confirm', { json: { token: randomToken(32), password: NEW_PASSWORD }, ip });
      expect(res.status).toBe(400);
    }
    // Even the right token is refused once the address has used up its guesses.
    const blocked = await call(t, '/auth/reset/confirm', { json: { token, password: NEW_PASSWORD }, ip });
    expect(blocked.status).toBe(429);
    expect((await json<ApiError>(blocked)).code).toBe('rate_limited');
    expect((await login(t, a.email, OLD_PASSWORD)).status).toBe(200);
  });

  it('needs no session and is reachable under /api, as index.ts mounts it', async () => {
    const t = makeEnv();
    const a = await signUp(t);
    const token = await seedReset(t.env.DB, a.user.id);
    const app = new Hono<{ Bindings: Env }>().route('/api', api);
    const res = await app.request(
      '/api/auth/reset/confirm',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': `test-ip-${newId()}` },
        body: JSON.stringify({ token, password: NEW_PASSWORD }),
      },
      t.env,
    );
    expect(res.status).toBe(200);
    expect((await login(t, a.email, NEW_PASSWORD)).status).toBe(200);
  });
});

describe('sendMail', () => {
  const mail = { to: 'owner@example.com', subject: 'Hello', text: 'Body text' };

  it('posts to Resend and reports whether it was accepted', async () => {
    const env = { RESEND_API_KEY: 're_test_mail_key', MAIL_FROM: 'Sitebot <no-reply@example.com>' };
    const sent = mockMail();
    expect(await sendMail(env, mail)).toBe(true);
    expect(sent).toEqual([
      {
        url: 'https://api.resend.com/emails',
        authorization: 'Bearer re_test_mail_key',
        body: { from: 'Sitebot <no-reply@example.com>', to: ['owner@example.com'], subject: 'Hello', text: 'Body text' },
      },
    ]);
    const init = vi.mocked(globalThis.fetch).mock.calls[0]?.[1];
    expect(init?.method).toBe('POST');
    expect(init?.body as string).not.toContain('re_test_mail_key');
  });

  it('returns false, without logging the key or the text, when Resend refuses or is unreachable', async () => {
    const env = { RESEND_API_KEY: 're_test_mail_key', MAIL_FROM: 'Sitebot <no-reply@example.com>' };
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockMail(422);
    expect(await sendMail(env, mail)).toBe(false);
    vi.mocked(globalThis.fetch).mockRejectedValue(new Error('re_test_mail_key Body text'));
    expect(await sendMail(env, mail)).toBe(false);
    const logged = JSON.stringify(log.mock.calls);
    expect(log).toHaveBeenCalledTimes(2);
    expect(logged).not.toContain('re_test_mail_key');
    expect(logged).not.toContain('Body text');
    expect(logged).not.toContain('owner@example.com');
  });

  it('makes no request unless both the key and the from address are set', async () => {
    const sent = mockMail();
    expect(await sendMail({}, mail)).toBe(false);
    expect(await sendMail({ RESEND_API_KEY: 're_test_mail_key' }, mail)).toBe(false);
    expect(await sendMail({ MAIL_FROM: 'Sitebot <no-reply@example.com>' }, mail)).toBe(false);
    expect(await sendMail({ RESEND_API_KEY: '', MAIL_FROM: '' }, mail)).toBe(false);
    expect(sent).toEqual([]);
  });
});
