import { Hono, type Context } from 'hono';
import {
  LIMITS,
  type ApiError,
  type ConversationSummary,
  type Message,
  type SiteUsage,
  type SourceLink,
  type User,
} from '@sitebot/shared';
import {
  DUMMY_PASSWORD_HASH,
  createSession,
  destroySession,
  hashPassword,
  originGuard,
  requireUser,
  verifyPassword,
  type AppEnv,
} from './auth';
import { parseJson, siteForUser, toSite, toSource, type SiteRow, type SourceRow } from './db';
import type { Env, IngestJob } from './env';
import { bareHost, isSafeUrl, normalizeUrl } from './ingest/url';
import { monthlyUsage, rateLimit } from './limits';
import { apiError, clientIp, newId, randomToken } from './util';

const MAX_SITES_PER_USER = 10;
const MAX_SOURCES_PER_SITE = 50;
const MAX_DOMAINS = 10;
const PREVIEW_CHARS = 120;
const CONVERSATION_PAGE = 50;
const BAD_LOGIN = 'Wrong email or password';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const COLOR = /^#[0-9a-fA-F]{6}$/;
const HOST_LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const HOSTNAME = new RegExp(`^${HOST_LABEL}(?:\\.${HOST_LABEL})+$`);

const UPLOAD_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
};

type Ctx = Context<AppEnv>;
type Body = Record<string, unknown>;

const invalid = (c: Ctx, message: string): Response => apiError(c, 400, 'invalid', message);

// Someone else's site looks exactly like a missing one, so ids cannot be probed.
const notFound = (c: Ctx): Response => apiError(c, 404, 'not_found', 'Not found');

async function readJson(c: Ctx): Promise<Body | null> {
  try {
    const body: unknown = await c.req.json();
    return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Body) : null;
  } catch {
    return null;
  }
}

/** The trimmed string when its length is within [min, max], else null. */
function text(value: unknown, min: number, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length >= min && trimmed.length <= max ? trimmed : null;
}

const ownedSite = (c: Ctx): Promise<SiteRow | null> =>
  siteForUser(c.env.DB, c.req.param('id') ?? '', c.get('user').id);

const stripWww = (host: string): string => host.replace(/^www\./, '');

const hostOf = (url: string): string => bareHost(url).replace(/\.$/, '');

function parseDomains(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_DOMAINS) return null;
  const domains = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string') return null;
    const host = entry.trim().toLowerCase();
    // A dot is required so a bare TLD such as `com` cannot allow every site under it.
    if (host.length > 253 || (host !== 'localhost' && !HOSTNAME.test(host))) return null;
    domains.add(host);
  }
  return [...domains];
}

async function sourceLimitReached(db: D1Database, siteId: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT COUNT(*) AS n FROM sources WHERE site_id = ?1')
    .bind(siteId)
    .first<{ n: number }>();
  return (row?.n ?? 0) >= MAX_SOURCES_PER_SITE;
}

const sourceLimitError = (c: Ctx): Response =>
  invalid(c, `A site can have at most ${MAX_SOURCES_PER_SITE} sources`);

interface NewSource {
  id: string;
  siteId: string;
  kind: SourceRow['kind'];
  label: string;
  r2Key?: string;
  content?: string;
}

function insertSource(db: D1Database, source: NewSource, now: number): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO sources (id, site_id, kind, label, r2_key, content, status, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7, ?7)`,
    )
    .bind(source.id, source.siteId, source.kind, source.label, source.r2Key ?? null, source.content ?? null, now);
}

async function enqueue(env: Env, job: Exclude<IngestJob, { type: 'page' }>): Promise<void> {
  try {
    await env.INGEST_QUEUE.send(job);
  } catch {
    // Without this the source would sit in 'pending' forever with no job behind it.
    await env.DB.prepare(
      `UPDATE sources SET status = 'error', error = ?1, updated_at = ?2 WHERE id = ?3 AND site_id = ?4`,
    )
      .bind('Could not start processing. Please add this source again.', Date.now(), job.sourceId, job.siteId)
      .run();
  }
}

async function sourceResponse(c: Ctx, siteId: string, sourceId: string): Promise<Response> {
  const row = await c.env.DB.prepare('SELECT * FROM sources WHERE id = ?1 AND site_id = ?2')
    .bind(sourceId, siteId)
    .first<SourceRow>();
  return row ? c.json({ source: toSource(row) }) : notFound(c);
}

export const api = new Hono<AppEnv>();

api.onError((err, c) => {
  console.error('api error:', err instanceof Error ? err.message : 'unknown');
  // ApiErrorCode has no server-error member; the 500 status is what tells clients apart.
  return c.json<ApiError>({ error: 'Something went wrong', code: 'invalid' }, 500);
});

api.use('*', originGuard);

// ---------- Auth ----------

api.post('/auth/signup', async (c) => {
  const limit = await rateLimit(c.env.DB, `signup:${clientIp(c)}`, 5, 3600);
  if (!limit.ok) {
    return apiError(c, 429, 'rate_limited', 'Too many signups. Try again later.', limit.retryAfter);
  }
  const body = await readJson(c);
  if (!body) return invalid(c, 'Invalid JSON body');
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (email.length > 254 || !EMAIL.test(email)) return invalid(c, 'Enter a valid email address');
  const password = body.password;
  if (typeof password !== 'string' || password.length < 8 || password.length > 200) {
    return invalid(c, 'Password must be 8 to 200 characters');
  }

  const user: User = { id: newId(), email };
  const inserted = await c.env.DB.prepare(
    `INSERT INTO users (id, email, password_hash, created_at) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(email) DO NOTHING`,
  )
    .bind(user.id, email, await hashPassword(password), Date.now())
    .run();
  if (inserted.meta.changes === 0) {
    return apiError(c, 409, 'conflict', 'An account with this email already exists');
  }
  await createSession(c, user.id);
  return c.json({ user });
});

api.post('/auth/login', async (c) => {
  const limit = await rateLimit(c.env.DB, `login:${clientIp(c)}`, 10, 300);
  if (!limit.ok) {
    return apiError(c, 429, 'rate_limited', 'Too many login attempts. Try again later.', limit.retryAfter);
  }
  const body = await readJson(c);
  if (!body) return invalid(c, 'Invalid JSON body');
  if (typeof body.email !== 'string' || typeof body.password !== 'string') {
    return invalid(c, 'Email and password are required');
  }
  const email = body.email.trim().toLowerCase();
  // Signup never accepts a longer password, so skip the hash work for oversized input.
  if (body.password.length > 200) return apiError(c, 401, 'unauthorized', BAD_LOGIN);

  const row = await c.env.DB.prepare('SELECT id, email, password_hash FROM users WHERE email = ?1')
    .bind(email)
    .first<{ id: string; email: string; password_hash: string }>();
  // An unknown email still costs one hash, so timing does not reveal which accounts exist.
  const ok = await verifyPassword(body.password, row?.password_hash ?? DUMMY_PASSWORD_HASH);
  if (!row || !ok) return apiError(c, 401, 'unauthorized', BAD_LOGIN);

  await createSession(c, row.id);
  const user: User = { id: row.id, email: row.email };
  return c.json({ user });
});

// Everything registered below this line needs a session.
api.use('*', requireUser);

api.post('/auth/logout', async (c) => {
  await destroySession(c);
  return c.json({ ok: true as const });
});

api.get('/auth/me', (c) => c.json({ user: c.get('user') }));

// ---------- Sites ----------

api.get('/sites', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM sites WHERE user_id = ?1 ORDER BY created_at DESC, rowid DESC',
  )
    .bind(c.get('user').id)
    .all<SiteRow>();
  return c.json({ sites: results.map(toSite) });
});

api.post('/sites', async (c) => {
  const body = await readJson(c);
  if (!body) return invalid(c, 'Invalid JSON body');
  const name = text(body.name, 1, 80);
  if (!name) return invalid(c, 'Name must be 1 to 80 characters');
  const url = typeof body.url === 'string' ? body.url.trim() : '';
  const startUrl = isSafeUrl(url) ? normalizeUrl(url) : null;
  if (!startUrl) return invalid(c, 'Enter a public http(s) URL, for example https://example.com');

  const db = c.env.DB;
  const userId = c.get('user').id;
  const count = await db.prepare('SELECT COUNT(*) AS n FROM sites WHERE user_id = ?1').bind(userId).first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_SITES_PER_USER) {
    return invalid(c, `You can have at most ${MAX_SITES_PER_USER} sites`);
  }

  const siteId = newId();
  const sourceId = newId();
  const now = Date.now();
  await db.batch([
    db
      .prepare(
        `INSERT INTO sites (id, user_id, name, public_key, domains, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      )
      .bind(siteId, userId, name, `pk_${randomToken(16)}`, JSON.stringify([hostOf(startUrl)]), now),
    insertSource(db, { id: sourceId, siteId, kind: 'crawl', label: startUrl }, now),
  ]);
  await enqueue(c.env, { type: 'crawl', siteId, sourceId });

  const site = await siteForUser(db, siteId, userId);
  return site ? c.json({ site: toSite(site) }) : notFound(c);
});

api.get('/sites/:id', async (c) => {
  const site = await ownedSite(c);
  if (!site) return notFound(c);
  const usage: SiteUsage = { ...(await monthlyUsage(c.env.DB, site.id)), cap: site.monthly_cap };
  return c.json({ site: toSite(site), usage });
});

api.patch('/sites/:id', async (c) => {
  const site = await ownedSite(c);
  if (!site) return notFound(c);
  const body = await readJson(c);
  if (!body) return invalid(c, 'Invalid JSON body');

  // Only the columns named here can change: monthly_cap, model and public_key are not editable.
  const sets: string[] = [];
  const values: string[] = [];
  const set = (column: string, value: string): void => {
    values.push(value);
    sets.push(`${column} = ?${values.length}`);
  };

  if (body.name !== undefined) {
    const name = text(body.name, 1, 80);
    if (!name) return invalid(c, 'Name must be 1 to 80 characters');
    set('name', name);
  }
  if (body.greeting !== undefined) {
    const greeting = text(body.greeting, 1, 200);
    if (!greeting) return invalid(c, 'Greeting must be 1 to 200 characters');
    set('greeting', greeting);
  }
  if (body.instructions !== undefined) {
    const instructions = text(body.instructions, 0, 2000);
    if (instructions === null) return invalid(c, 'Instructions must be at most 2000 characters');
    set('instructions', instructions);
  }
  if (body.color !== undefined) {
    if (typeof body.color !== 'string' || !COLOR.test(body.color)) {
      return invalid(c, 'Color must be a hex value like #2563eb');
    }
    set('color', body.color);
  }
  if (body.position !== undefined) {
    if (body.position !== 'left' && body.position !== 'right') {
      return invalid(c, "Position must be 'left' or 'right'");
    }
    set('position', body.position);
  }
  if (body.domains !== undefined) {
    const domains = parseDomains(body.domains);
    if (!domains) {
      return invalid(c, `Domains must be 1 to ${MAX_DOMAINS} plain hostnames such as example.com`);
    }
    set('domains', JSON.stringify(domains));
  }

  const userId = c.get('user').id;
  if (sets.length > 0) {
    await c.env.DB.prepare(
      `UPDATE sites SET ${sets.join(', ')} WHERE id = ?${values.length + 1} AND user_id = ?${values.length + 2}`,
    )
      .bind(...values, site.id, userId)
      .run();
  }
  const updated = await siteForUser(c.env.DB, site.id, userId);
  return updated ? c.json({ site: toSite(updated) }) : notFound(c);
});

// ---------- Sources ----------

api.get('/sites/:id/sources', async (c) => {
  const site = await ownedSite(c);
  if (!site) return notFound(c);
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM sources WHERE site_id = ?1 ORDER BY created_at DESC, rowid DESC',
  )
    .bind(site.id)
    .all<SourceRow>();
  return c.json({ sources: results.map(toSource) });
});

api.post('/sites/:id/sources/crawl', async (c) => {
  const site = await ownedSite(c);
  if (!site) return notFound(c);
  const body = await readJson(c);
  if (!body) return invalid(c, 'Invalid JSON body');
  const url = typeof body.url === 'string' ? body.url.trim() : '';
  const startUrl = isSafeUrl(url) ? normalizeUrl(url) : null;
  if (!startUrl) return invalid(c, 'Enter a public http(s) URL, for example https://example.com');

  // Owners may only crawl their own site: the host must be on the site's allowlist.
  const host = hostOf(startUrl);
  const onOwnSite = parseJson<string[]>(site.domains, []).some((d) => {
    const domain = stripWww(d.trim().toLowerCase());
    return domain !== '' && (host === domain || host.endsWith(`.${domain}`));
  });
  if (!onOwnSite) return invalid(c, "The URL must be on one of this site's domains");
  if (await sourceLimitReached(c.env.DB, site.id)) return sourceLimitError(c);

  const sourceId = newId();
  await insertSource(c.env.DB, { id: sourceId, siteId: site.id, kind: 'crawl', label: startUrl }, Date.now()).run();
  await enqueue(c.env, { type: 'crawl', siteId: site.id, sourceId });
  return sourceResponse(c, site.id, sourceId);
});

api.post('/sites/:id/sources/upload', async (c) => {
  const site = await ownedSite(c);
  if (!site) return notFound(c);

  const maxMb = LIMITS.uploadMaxBytes / (1024 * 1024);
  const tooLarge = `File is too large (max ${maxMb} MB)`;
  // Refuse obviously oversized bodies before buffering them; the slack covers multipart framing.
  if (Number(c.req.header('content-length') ?? 0) > LIMITS.uploadMaxBytes + 64 * 1024) {
    return invalid(c, tooLarge);
  }
  let file: File | string | null;
  try {
    file = (await c.req.formData()).get('file');
  } catch {
    return invalid(c, 'Expected a multipart form with a `file` field');
  }
  if (file === null || typeof file === 'string') {
    return invalid(c, 'Expected a multipart form with a `file` field');
  }

  const dot = file.name.lastIndexOf('.');
  const ext = dot === -1 ? '' : file.name.slice(dot).toLowerCase();
  const contentType = (LIMITS.uploadExtensions as readonly string[]).includes(ext) ? UPLOAD_TYPES[ext] : undefined;
  if (!contentType) return invalid(c, `File type must be one of ${LIMITS.uploadExtensions.join(', ')}`);
  if (file.size < 1) return invalid(c, 'File is empty');
  if (file.size > LIMITS.uploadMaxBytes) return invalid(c, tooLarge);
  if (await sourceLimitReached(c.env.DB, site.id)) return sourceLimitError(c);

  // Keep the (lowercased) extension when shortening: the ingest step picks a parser by it.
  const stem = file.name.slice(0, dot).replace(/[^A-Za-z0-9._-]/g, '_');
  const safeName = stem.slice(0, 100 - ext.length) + ext;
  const sourceId = newId();
  const r2Key = `${site.id}/${sourceId}/${safeName}`;
  await c.env.UPLOADS.put(r2Key, await file.arrayBuffer(), { httpMetadata: { contentType } });
  try {
    await insertSource(
      c.env.DB,
      { id: sourceId, siteId: site.id, kind: 'upload', label: safeName, r2Key },
      Date.now(),
    ).run();
  } catch (err) {
    // No row points at the object, so nothing would ever clean it up.
    await c.env.UPLOADS.delete(r2Key);
    throw err;
  }
  await enqueue(c.env, { type: 'upload', siteId: site.id, sourceId });
  return sourceResponse(c, site.id, sourceId);
});

api.post('/sites/:id/sources/qa', async (c) => {
  const site = await ownedSite(c);
  if (!site) return notFound(c);
  const body = await readJson(c);
  if (!body) return invalid(c, 'Invalid JSON body');
  const question = text(body.question, 1, 300);
  if (!question) return invalid(c, 'Question must be 1 to 300 characters');
  const answer = text(body.answer, 1, 2000);
  if (!answer) return invalid(c, 'Answer must be 1 to 2000 characters');
  if (await sourceLimitReached(c.env.DB, site.id)) return sourceLimitError(c);

  const sourceId = newId();
  await insertSource(
    c.env.DB,
    { id: sourceId, siteId: site.id, kind: 'qa', label: question, content: answer },
    Date.now(),
  ).run();
  await enqueue(c.env, { type: 'qa', siteId: site.id, sourceId });
  return sourceResponse(c, site.id, sourceId);
});

// ---------- Conversations ----------

api.get('/sites/:id/conversations', async (c) => {
  const site = await ownedSite(c);
  if (!site) return notFound(c);
  const { results } = await c.env.DB.prepare(
    `SELECT c.id AS id, c.created_at AS createdAt, c.updated_at AS updatedAt,
            (SELECT COUNT(*) FROM messages m
              WHERE m.conversation_id = c.id AND m.site_id = ?1) AS messageCount,
            COALESCE((SELECT substr(m.content, 1, ?2) FROM messages m
              WHERE m.conversation_id = c.id AND m.site_id = ?1 AND m.role = 'user'
              ORDER BY m.created_at, m.rowid LIMIT 1), '') AS preview
     FROM conversations c
     WHERE c.site_id = ?1
     ORDER BY c.updated_at DESC, c.rowid DESC
     LIMIT ?3`,
  )
    .bind(site.id, PREVIEW_CHARS, CONVERSATION_PAGE)
    .all<ConversationSummary>();
  return c.json({ conversations: results });
});

api.get('/sites/:id/conversations/:cid', async (c) => {
  const site = await ownedSite(c);
  if (!site) return notFound(c);
  const db = c.env.DB;
  const conversation = await db
    .prepare('SELECT id FROM conversations WHERE id = ?1 AND site_id = ?2')
    .bind(c.req.param('cid'), site.id)
    .first<{ id: string }>();
  if (!conversation) return notFound(c);

  const { results } = await db
    .prepare(
      `SELECT id, role, content, sources, created_at FROM messages
       WHERE conversation_id = ?1 AND site_id = ?2
       ORDER BY created_at, rowid`,
    )
    .bind(conversation.id, site.id)
    .all<{ id: string; role: string; content: string; sources: string; created_at: number }>();
  const messages: Message[] = results.map((row) => {
    const sources = parseJson<SourceLink[]>(row.sources, []);
    return {
      id: row.id,
      role: row.role === 'assistant' ? 'assistant' : 'user',
      content: row.content,
      sources: Array.isArray(sources) ? sources : [],
      createdAt: row.created_at,
    };
  });
  return c.json({ messages });
});

// The parent app's 404 is plain text; keep every /api failure in the ApiError shape.
api.all('*', (c) => notFound(c));
