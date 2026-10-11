import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import type { ApiError, Lead, LeadRequest, UnansweredQuestion, User } from '@sitebot/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/api';
import { publicApi } from '../src/chat';
import { newId } from '../src/util';
import { makeEnv, type TestEnv } from './helpers';

const ORIGIN = 'https://www.example.com';
const PASSWORD = 'a-long-enough-password';

interface Account {
  user: User;
  cookie: string;
}

/** Signs up through the real route, so the cookie is one the session check accepts. */
async function signUp(t: TestEnv): Promise<Account> {
  const res = await api.request(
    '/auth/signup',
    {
      method: 'POST',
      // Signup is rate limited per IP, so every test account comes from its own address.
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': `test-ip-${newId()}` },
      body: JSON.stringify({ email: `${newId()}@example.com`, password: PASSWORD }),
    },
    t.env,
  );
  expect(res.status).toBe(200);
  const token = /sb_session=([^;]*)/.exec(res.headers.get('set-cookie') ?? '')?.[1] ?? '';
  return { user: (await res.json<{ user: User }>()).user, cookie: `sb_session=${token}` };
}

interface TestSite {
  id: string;
  publicKey: string;
}

async function addSite(userId: string, options: { leadCapture?: boolean } = {}): Promise<TestSite> {
  const id = newId();
  const publicKey = `pk_${newId().replaceAll('-', '')}`;
  await env.DB.prepare(
    `INSERT INTO sites (id, user_id, name, public_key, domains, lead_capture, created_at)
     VALUES (?1, ?2, 'Test Site', ?3, '["example.com"]', ?4, ?5)`,
  )
    .bind(id, userId, publicKey, options.leadCapture === false ? 0 : 1, Date.now())
    .run();
  return { id, publicKey };
}

async function addConversation(siteId: string): Promise<string> {
  const id = newId();
  await env.DB.prepare('INSERT INTO conversations (id, site_id, created_at, updated_at) VALUES (?1, ?2, 1, 1)')
    .bind(id, siteId)
    .run();
  return id;
}

interface SeedMessage {
  conversationId: string;
  content: string;
  at: number;
  role?: 'user' | 'assistant';
  answered?: 0 | 1;
}

async function addMessages(siteId: string, messages: SeedMessage[]): Promise<void> {
  await env.DB.batch(
    messages.map((m) =>
      env.DB.prepare(
        `INSERT INTO messages (id, conversation_id, site_id, role, content, sources, created_at, answered)
         VALUES (?1, ?2, ?3, ?4, ?5, '[]', ?6, ?7)`,
      ).bind(newId(), m.conversationId, siteId, m.role ?? 'user', m.content, m.at, m.answered ?? 0),
    ),
  );
}

async function addLead(
  siteId: string,
  lead: { email: string; question?: string; conversationId?: string | null; at: number },
): Promise<string> {
  const id = newId();
  await env.DB.prepare(
    'INSERT INTO leads (id, site_id, conversation_id, email, question, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)',
  )
    .bind(id, siteId, lead.conversationId ?? null, lead.email, lead.question ?? '', lead.at)
    .run();
  return id;
}

const get = async (t: TestEnv, path: string, cookie?: string): Promise<Response> =>
  api.request(path, { headers: cookie ? { cookie } : {} }, t.env);

async function unanswered(t: TestEnv, siteId: string, cookie: string): Promise<UnansweredQuestion[]> {
  const res = await get(t, `/sites/${siteId}/unanswered`, cookie);
  expect(res.status).toBe(200);
  return (await res.json<{ questions: UnansweredQuestion[] }>()).questions;
}

async function leads(t: TestEnv, siteId: string, cookie: string): Promise<Lead[]> {
  const res = await get(t, `/sites/${siteId}/leads`, cookie);
  expect(res.status).toBe(200);
  return (await res.json<{ leads: Lead[] }>()).leads;
}

async function postLead(
  t: TestEnv,
  body: unknown,
  options: { origin?: string | null; ip?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'cf-connecting-ip': options.ip ?? `lead-ip-${newId()}`,
  };
  const origin = options.origin === undefined ? ORIGIN : options.origin;
  if (origin !== null) headers.Origin = origin;
  const ctx = createExecutionContext();
  const res = await publicApi.request(
    '/lead',
    { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) },
    t.env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

async function storedLeads(siteId: string) {
  const { results } = await env.DB.prepare(
    'SELECT email, question, conversation_id FROM leads WHERE site_id = ?1 ORDER BY created_at, rowid',
  )
    .bind(siteId)
    .all<{ email: string; question: string; conversation_id: string | null }>();
  return results;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GET /api/sites/:id/unanswered', () => {
  it('groups by wording, counts, and lists the most recent first', async () => {
    const t = makeEnv();
    const owner = await signUp(t);
    const site = await addSite(owner.user.id);
    const first = await addConversation(site.id);
    const second = await addConversation(site.id);
    await addMessages(site.id, [
      { conversationId: first, content: 'How much?', at: 1000 },
      { conversationId: first, content: 'Do you ship to Mars?', at: 2000 },
      { conversationId: second, content: 'how   MUCH?', at: 3000 },
      // Not listed: an answered question, and the bot's own replies.
      { conversationId: second, content: 'Where are you based?', at: 4000, answered: 1 },
      { conversationId: second, content: "I don't know.", at: 3001, role: 'assistant' },
    ]);

    expect(await unanswered(t, site.id, owner.cookie)).toEqual([
      // The latest wording, time and conversation stand for the group.
      { question: 'how   MUCH?', count: 2, lastAskedAt: 3000, conversationId: second },
      { question: 'Do you ship to Mars?', count: 1, lastAskedAt: 2000, conversationId: first },
    ]);
  });

  it('drops a question once the owner has answered it with a Q&A pair', async () => {
    const t = makeEnv();
    const owner = await signUp(t);
    const site = await addSite(owner.user.id);
    const other = await addSite(owner.user.id);
    const conversation = await addConversation(site.id);
    await addMessages(site.id, [
      { conversationId: conversation, content: 'Do you ship to Mars?', at: 1000 },
      { conversationId: conversation, content: 'How much?', at: 2000 },
    ]);
    const addQa = (siteId: string, label: string) =>
      env.DB.prepare(
        `INSERT INTO sources (id, site_id, kind, label, content, status, created_at, updated_at)
         VALUES (?1, ?2, 'qa', ?3, 'An answer.', 'ready', 1, 1)`,
      )
        .bind(newId(), siteId, label)
        .run();
    // Same wording apart from case and spacing; and one on another site, which must not count.
    await addQa(site.id, '  do you SHIP to mars? ');
    await addQa(other.id, 'How much?');

    expect((await unanswered(t, site.id, owner.cookie)).map((q) => q.question)).toEqual(['How much?']);
  });

  it('drops a miss when the same question was answered on a later ask', async () => {
    const t = makeEnv();
    const owner = await signUp(t);
    const site = await addSite(owner.user.id);
    const conversation = await addConversation(site.id);
    await addMessages(site.id, [
      // Asked before the new content was searchable, then again once it was.
      { conversationId: conversation, content: 'When is support open?', at: 1000 },
      { conversationId: conversation, content: 'when is support OPEN?', at: 2000, answered: 1 },
      // Answered once, then missed later: still a live problem.
      { conversationId: conversation, content: 'Do you ship abroad?', at: 3000, answered: 1 },
      { conversationId: conversation, content: 'Do you ship abroad?', at: 4000 },
    ]);

    expect(await unanswered(t, site.id, owner.cookie)).toEqual([
      { question: 'Do you ship abroad?', count: 1, lastAskedAt: 4000, conversationId: conversation },
    ]);
  });

  it('returns an empty list for a site with no unanswered questions', async () => {
    const t = makeEnv();
    const owner = await signUp(t);
    const site = await addSite(owner.user.id);
    expect(await unanswered(t, site.id, owner.cookie)).toEqual([]);
  });

  it('returns at most 100 groups, the newest ones', async () => {
    const t = makeEnv();
    const owner = await signUp(t);
    const site = await addSite(owner.user.id);
    const conversation = await addConversation(site.id);
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 105)
       INSERT INTO messages (id, conversation_id, site_id, role, content, sources, created_at, answered)
       SELECT ?1 || '-' || i, ?2, ?3, 'user', 'Question ' || i || '?', '[]', 1000 + i, 0 FROM n`,
    )
      .bind(newId(), conversation, site.id)
      .run();

    const questions = await unanswered(t, site.id, owner.cookie);
    expect(questions).toHaveLength(100);
    expect(questions[0]?.question).toBe('Question 105?');
    expect(questions.at(-1)?.question).toBe('Question 6?');
  });

  it('looks at the latest 1000 unanswered messages only', async () => {
    const t = makeEnv();
    const owner = await signUp(t);
    const site = await addSite(owner.user.id);
    const conversation = await addConversation(site.id);
    await addMessages(site.id, [{ conversationId: conversation, content: 'An old question?', at: 1 }]);
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1000)
       INSERT INTO messages (id, conversation_id, site_id, role, content, sources, created_at, answered)
       SELECT ?1 || '-' || i, ?2, ?3, 'user', 'Same question?', '[]', 1000 + i, 0 FROM n`,
    )
      .bind(newId(), conversation, site.id)
      .run();

    expect(await unanswered(t, site.id, owner.cookie)).toEqual([
      { question: 'Same question?', count: 1000, lastAskedAt: 2000, conversationId: conversation },
    ]);
  });
});

describe('GET /api/sites/:id/leads', () => {
  it('lists the leads of the site, newest first', async () => {
    const t = makeEnv();
    const owner = await signUp(t);
    const site = await addSite(owner.user.id);
    const conversation = await addConversation(site.id);
    const older = await addLead(site.id, { email: 'first@example.com', question: 'Do you ship?', at: 1000 });
    const newer = await addLead(site.id, { email: 'second@example.com', conversationId: conversation, at: 2000 });

    expect(await leads(t, site.id, owner.cookie)).toEqual([
      { id: newer, email: 'second@example.com', question: '', conversationId: conversation, createdAt: 2000 },
      { id: older, email: 'first@example.com', question: 'Do you ship?', conversationId: null, createdAt: 1000 },
    ]);
  });

  it('returns at most 200 leads', async () => {
    const t = makeEnv();
    const owner = await signUp(t);
    const site = await addSite(owner.user.id);
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 205)
       INSERT INTO leads (id, site_id, email, question, created_at)
       SELECT ?1 || '-' || i, ?2, 'v' || i || '@example.com', '', 1000 + i FROM n`,
    )
      .bind(newId(), site.id)
      .run();

    const list = await leads(t, site.id, owner.cookie);
    expect(list).toHaveLength(200);
    expect(list[0]?.email).toBe('v205@example.com');
    expect(list.at(-1)?.email).toBe('v6@example.com');
  });
});

describe('insights tenant isolation', () => {
  it("TENANT ISOLATION: user B gets 404 on user A's unanswered questions and leads", async () => {
    const t = makeEnv();
    const a = await signUp(t);
    const b = await signUp(t);
    const siteA = await addSite(a.user.id);
    const siteB = await addSite(b.user.id);
    const conversation = await addConversation(siteA.id);
    await addMessages(siteA.id, [{ conversationId: conversation, content: 'SITE_A_QUESTION', at: 1000 }]);
    await addLead(siteA.id, { email: 'site-a-visitor@example.com', question: 'SITE_A_QUESTION', at: 1000 });

    for (const path of [`/sites/${siteA.id}/unanswered`, `/sites/${siteA.id}/leads`]) {
      const res = await get(t, path, b.cookie);
      expect(res.status).toBe(404);
      const text = await res.text();
      expect((JSON.parse(text) as ApiError).code).toBe('not_found');
      expect(text).not.toContain('SITE_A_QUESTION');
      expect(text).not.toContain('site-a-visitor');
    }

    // B's own site shows none of A's rows, and A still sees its own.
    expect(await unanswered(t, siteB.id, b.cookie)).toEqual([]);
    expect(await leads(t, siteB.id, b.cookie)).toEqual([]);
    expect(await unanswered(t, siteA.id, a.cookie)).toHaveLength(1);
    expect(await leads(t, siteA.id, a.cookie)).toHaveLength(1);
  });

  it('answers 401 without a session and 404 for an unknown site', async () => {
    const t = makeEnv();
    const owner = await signUp(t);
    const site = await addSite(owner.user.id);
    for (const path of [`/sites/${site.id}/unanswered`, `/sites/${site.id}/leads`]) {
      const res = await get(t, path);
      expect(res.status).toBe(401);
      expect((await res.json<ApiError>()).code).toBe('unauthorized');
    }
    for (const path of [`/sites/${newId()}/unanswered`, `/sites/${newId()}/leads`]) {
      expect((await get(t, path, owner.cookie)).status).toBe(404);
    }
  });
});

describe('POST /v1/lead', () => {
  it('stores a trimmed, lowercased email with the question and conversation', async () => {
    const t = makeEnv();
    const owner = await signUp(t);
    const site = await addSite(owner.user.id);
    const conversation = await addConversation(site.id);
    const logs = [
      vi.spyOn(console, 'log').mockImplementation(() => {}),
      vi.spyOn(console, 'warn').mockImplementation(() => {}),
      vi.spyOn(console, 'error').mockImplementation(() => {}),
    ];

    const body: LeadRequest = {
      siteKey: site.publicKey,
      email: '  Visitor@Example.COM ',
      conversationId: conversation,
      question: '  Do you ship to Mars?  ',
    };
    const res = await postLead(t, body);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(res.headers.get('vary')).toBe('Origin');
    expect(await storedLeads(site.id)).toEqual([
      { email: 'visitor@example.com', question: 'Do you ship to Mars?', conversation_id: conversation },
    ]);
    // The address is personal data: it goes to the table and nowhere else.
    expect(JSON.stringify(logs.map((spy) => spy.mock.calls)).toLowerCase()).not.toContain('visitor@example.com');

    // The owner sees it in the dashboard.
    const [lead] = await leads(t, site.id, owner.cookie);
    expect(lead).toMatchObject({
      email: 'visitor@example.com',
      question: 'Do you ship to Mars?',
      conversationId: conversation,
    });
  });

  it('accepts a lead without a question or conversation, and cuts a long question', async () => {
    const t = makeEnv();
    const owner = await signUp(t);
    const site = await addSite(owner.user.id);

    expect((await postLead(t, { siteKey: site.publicKey, email: 'a@example.com' })).status).toBe(200);
    const long = await postLead(t, { siteKey: site.publicKey, email: 'b@example.com', question: 'x'.repeat(1500) });
    expect(long.status).toBe(200);
    // Non-string extras are ignored rather than stored.
    const odd = await postLead(t, { siteKey: site.publicKey, email: 'c@example.com', question: 7, conversationId: 9 });
    expect(odd.status).toBe(200);

    const stored = await storedLeads(site.id);
    expect(stored.map((row) => [row.email, row.question.length, row.conversation_id])).toEqual([
      ['a@example.com', 0, null],
      ['b@example.com', 1000, null],
      ['c@example.com', 0, null],
    ]);
  });

  it('rejects a wrong Origin and a missing Origin with 403 and no CORS header', async () => {
    const t = makeEnv();
    const owner = await signUp(t);
    const site = await addSite(owner.user.id);

    for (const origin of ['https://evil.com', 'https://example.com.evil.com', null]) {
      const res = await postLead(t, { siteKey: site.publicKey, email: 'visitor@example.com' }, { origin });
      expect(res.status).toBe(403);
      expect((await res.json<ApiError>()).code).toBe('forbidden_origin');
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    }
    expect(await storedLeads(site.id)).toEqual([]);
  });

  it('answers 400 when the site does not collect contact details', async () => {
    const t = makeEnv();
    const owner = await signUp(t);
    const site = await addSite(owner.user.id, { leadCapture: false });

    const res = await postLead(t, { siteKey: site.publicKey, email: 'visitor@example.com' });
    expect(res.status).toBe(400);
    expect(await res.json<ApiError>()).toEqual({
      error: 'This site does not collect contact details',
      code: 'invalid',
    });
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(await storedLeads(site.id)).toEqual([]);
  });

  it('rejects a bad email with 400', async () => {
    const t = makeEnv();
    const owner = await signUp(t);
    const site = await addSite(owner.user.id);

    const bad: unknown[] = [
      '',
      '   ',
      'not-an-email',
      'missing@tld',
      '@example.com',
      'two words@example.com',
      'a@b@example.com',
      `${'x'.repeat(250)}@example.com`,
      42,
      null,
      undefined,
    ];
    for (const email of bad) {
      const res = await postLead(t, { siteKey: site.publicKey, email });
      expect(res.status, String(email)).toBe(400);
      expect((await res.json<ApiError>()).code).toBe('invalid');
      expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    }
    expect(await storedLeads(site.id)).toEqual([]);

    // The longest address that is still allowed.
    const longest = `${'x'.repeat(242)}@example.com`;
    expect(longest).toHaveLength(254);
    expect((await postLead(t, { siteKey: site.publicKey, email: longest })).status).toBe(200);
  });

  it('rejects a body that is not JSON or has no site key, and an unknown key', async () => {
    const t = makeEnv();
    for (const body of ['not json', 'null', { email: 'visitor@example.com' }, { siteKey: 7, email: 'a@example.com' }]) {
      const res = await postLead(t, body);
      expect(res.status).toBe(400);
      expect((await res.json<ApiError>()).code).toBe('invalid');
    }
    const unknown = await postLead(t, { siteKey: 'pk_does_not_exist', email: 'visitor@example.com' });
    expect(unknown.status).toBe(404);
    expect((await unknown.json<ApiError>()).code).toBe('not_found');
    expect(unknown.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('TENANT ISOLATION: stores a conversationId from another site as null', async () => {
    const t = makeEnv();
    const a = await signUp(t);
    const b = await signUp(t);
    const siteA = await addSite(a.user.id);
    const siteB = await addSite(b.user.id);
    const foreign = await addConversation(siteA.id);

    const res = await postLead(t, { siteKey: siteB.publicKey, email: 'visitor@example.com', conversationId: foreign });
    expect(res.status).toBe(200);
    expect(await storedLeads(siteB.id)).toEqual([
      { email: 'visitor@example.com', question: '', conversation_id: null },
    ]);
    expect(await storedLeads(siteA.id)).toEqual([]);

    // Same for an id that matches no conversation at all.
    await postLead(t, { siteKey: siteB.publicKey, email: 'other@example.com', conversationId: newId() });
    expect((await storedLeads(siteB.id))[1]?.conversation_id).toBeNull();
  });

  it('blocks the 4th lead from one IP in an hour', async () => {
    // A fixed clock keeps all requests inside one rate-limit window.
    vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 9, 11, 12, 30, 0));
    const t = makeEnv();
    const owner = await signUp(t);
    const site = await addSite(owner.user.id);
    const ip = '198.51.100.7';

    for (let i = 0; i < 3; i++) {
      const res = await postLead(t, { siteKey: site.publicKey, email: `visitor${i}@example.com` }, { ip });
      expect(res.status).toBe(200);
    }
    const res = await postLead(t, { siteKey: site.publicKey, email: 'visitor3@example.com' }, { ip });
    expect(res.status).toBe(429);
    const error = await res.json<ApiError>();
    expect(error.code).toBe('rate_limited');
    expect(error.retryAfter).toBe(1800);
    expect(res.headers.get('retry-after')).toBe('1800');
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(await storedLeads(site.id)).toHaveLength(3);

    // Another visitor of the same site is not affected.
    const other = await postLead(t, { siteKey: site.publicKey, email: 'else@example.com' }, { ip: '198.51.100.8' });
    expect(other.status).toBe(200);
  });

  it('blocks the 61st lead for one site in an hour, whatever the IP', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 9, 11, 12, 30, 0));
    const t = makeEnv();
    const owner = await signUp(t);
    const site = await addSite(owner.user.id);

    for (let i = 0; i < 60; i++) {
      const res = await postLead(t, { siteKey: site.publicKey, email: `visitor${i}@example.com` });
      expect(res.status).toBe(200);
    }
    const res = await postLead(t, { siteKey: site.publicKey, email: 'late@example.com' });
    expect(res.status).toBe(429);
    expect((await res.json<ApiError>()).code).toBe('rate_limited');
    expect(await storedLeads(site.id)).toHaveLength(60);
  });
});

describe('OPTIONS /v1/lead', () => {
  it('answers the preflight and reflects the Origin', async () => {
    const ctx = createExecutionContext();
    const res = await publicApi.request(
      '/lead',
      {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://anything.example',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'content-type',
        },
      },
      makeEnv().env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://anything.example');
    expect(res.headers.get('access-control-allow-methods')).toBe('POST');
    expect(res.headers.get('access-control-allow-headers')).toBe('content-type');
    expect(res.headers.get('access-control-max-age')).toBe('86400');
    expect(res.headers.get('vary')).toBe('Origin');
  });
});
