import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Lead, UnansweredQuestion } from '@sitebot/shared';
import type { AppEnv } from './auth';
import { siteForUser, type SiteRow } from './db';
import { apiError } from './util';

const UNANSWERED_SCAN = 1000;
const UNANSWERED_MAX = 100;
const LEADS_MAX = 200;

/** Unanswered questions and leads for the dashboard. Mounted under /api after the session check. */
export const insights = new Hono<AppEnv>();

type Ctx = Context<AppEnv>;

// Tenant isolation: someone else's site looks exactly like a site that does not exist.
const ownedSite = (c: Ctx): Promise<SiteRow | null> =>
  siteForUser(c.env.DB, c.req.param('id') ?? '', c.get('user').id);

const notFound = (c: Ctx): Response => apiError(c, 404, 'not_found', 'Site not found');

/** "How much?" and "  how   MUCH? " are the same question to the owner. */
const wordingKey = (text: string): string => text.toLowerCase().replace(/\s+/g, ' ').trim();

insights.get('/sites/:id/unanswered', async (c) => {
  const site = await ownedSite(c);
  if (!site) return notFound(c);
  const { results } = await c.env.DB.prepare(
    `SELECT content, conversation_id AS conversationId, created_at AS createdAt
     FROM messages WHERE site_id = ?1 AND role = 'user' AND answered = 0
     ORDER BY created_at DESC, rowid DESC LIMIT ${UNANSWERED_SCAN}`,
  )
    .bind(site.id)
    .all<{ content: string; conversationId: string; createdAt: number }>();

  // A question the owner has since answered with a Q&A pair is done: it must not keep showing.
  const { results: answeredRows } = await c.env.DB.prepare(
    "SELECT label FROM sources WHERE site_id = ?1 AND kind = 'qa'",
  )
    .bind(site.id)
    .all<{ label: string }>();
  const answered = new Set(answeredRows.map((row) => wordingKey(row.label)));

  // Rows arrive newest first, so the first row of a group supplies its wording, time and
  // conversation, and the Map's insertion order is already "most recent first".
  const groups = new Map<string, UnansweredQuestion>();
  for (const row of results) {
    const key = wordingKey(row.content);
    // Q&A labels are capped at 300 characters, and so is what "Answer it" saves.
    if (answered.has(key) || answered.has(key.slice(0, 300).trim())) continue;
    const group = groups.get(key);
    if (group) {
      group.count += 1;
    } else {
      groups.set(key, {
        question: row.content,
        count: 1,
        lastAskedAt: row.createdAt,
        conversationId: row.conversationId,
      });
    }
  }
  return c.json({ questions: [...groups.values()].slice(0, UNANSWERED_MAX) });
});

insights.get('/sites/:id/leads', async (c) => {
  const site = await ownedSite(c);
  if (!site) return notFound(c);
  const { results } = await c.env.DB.prepare(
    `SELECT id, email, question, conversation_id AS conversationId, created_at AS createdAt
     FROM leads WHERE site_id = ?1
     ORDER BY created_at DESC, rowid DESC LIMIT ${LEADS_MAX}`,
  )
    .bind(site.id)
    .all<Lead>();
  return c.json({ leads: results });
});
