import { Hono, type Context } from 'hono';
import { PASSWORD_RULE, hashPassword, isValidPassword, parseEmail, type AppEnv } from './auth';
import type { Env } from './env';
import { rateLimit } from './limits';
import { sendMail } from './mail';
import { apiError, clientIp, randomToken, sha256Hex } from './util';

const RESET_TTL_MIN = 60;
const TOKEN = /^[0-9a-f]{64}$/;
// One message for a wrong, used, and expired token, so the three cannot be told apart.
const BAD_TOKEN = 'This reset link is not valid or has expired. Request a new one.';

type Ctx = Context<AppEnv>;

async function readBody(c: Ctx): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await c.req.json();
    return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Creates the reset token for `email` and mails the link, if there is such an account.
 * Only the token's hash is stored; the token itself exists in the mail alone.
 */
async function startReset(env: Env, email: string): Promise<void> {
  const db = env.DB;
  const user = await db.prepare('SELECT id FROM users WHERE email = ?1').bind(email).first<{ id: string }>();
  if (!user) return;

  const token = randomToken(32);
  const now = Date.now();
  await db.batch([
    // A new request replaces any earlier link, so at most one works per account.
    db.prepare('DELETE FROM password_resets WHERE user_id = ?1').bind(user.id),
    db
      .prepare('INSERT INTO password_resets (id, user_id, expires_at) VALUES (?1, ?2, ?3)')
      .bind(await sha256Hex(token), user.id, now + RESET_TTL_MIN * 60_000),
  ]);

  // Without the dashboard's address there is no link to send.
  const appUrl = (env.APP_URL ?? '').trim().replace(/\/+$/, '');
  if (appUrl === '') return;
  await sendMail(env, {
    to: email,
    subject: 'Reset your Sitebot password',
    text: [
      'Someone asked to reset the password for your Sitebot account.',
      '',
      `Open this link to choose a new password. It works once and expires in ${RESET_TTL_MIN} minutes:`,
      `${appUrl}/#/reset/${token}`,
      '',
      'If this was not you, ignore this email. Your password has not changed.',
    ].join('\n'),
  });
}

/** Password reset routes. Mounted under /api before the session check: callers are signed out. */
export const resetRoutes = new Hono<AppEnv>();

resetRoutes.post('/auth/reset/request', async (c) => {
  const limit = await rateLimit(c.env.DB, `reset:${clientIp(c)}`, 5, 3600);
  if (!limit.ok) {
    return apiError(c, 429, 'rate_limited', 'Too many reset requests. Try again later.', limit.retryAfter);
  }
  const email = parseEmail((await readBody(c))?.email);
  if (!email) return apiError(c, 400, 'invalid', 'Enter a valid email address');

  // The answer must not show whether the account exists, in its body or in how long it takes.
  // So the lookup, the write and the mail all run after the response when the runtime allows it.
  const work = startReset(c.env, email).catch(() => {
    console.error('reset: request could not be completed');
  });
  let deferred = false;
  try {
    c.executionCtx.waitUntil(work);
    deferred = true;
  } catch {
    // No execution context (unit tests): finish the work before answering.
  }
  if (!deferred) await work;
  return c.json({ ok: true as const });
});

resetRoutes.post('/auth/reset/confirm', async (c) => {
  const limit = await rateLimit(c.env.DB, `reset-confirm:${clientIp(c)}`, 10, 3600);
  if (!limit.ok) {
    return apiError(c, 429, 'rate_limited', 'Too many attempts. Try again later.', limit.retryAfter);
  }
  const body = await readBody(c);
  if (!body) return apiError(c, 400, 'invalid', 'Invalid JSON body');
  const password = body.password;
  if (!isValidPassword(password)) return apiError(c, 400, 'invalid', PASSWORD_RULE);
  const token = body.token;
  if (typeof token !== 'string' || !TOKEN.test(token)) return apiError(c, 400, 'invalid', BAD_TOKEN);

  const db = c.env.DB;
  const id = await sha256Hex(token);
  const now = Date.now();
  const row = await db
    .prepare('SELECT user_id FROM password_resets WHERE id = ?1 AND used_at IS NULL AND expires_at > ?2')
    .bind(id, now)
    .first<{ user_id: string }>();
  if (!row) return apiError(c, 400, 'invalid', BAD_TOKEN);

  // One transaction. The first two statements act only while the token is still unused and
  // the third then spends it, so two requests racing with the same link cannot both win.
  const unused = 'EXISTS (SELECT 1 FROM password_resets WHERE id = ?2 AND used_at IS NULL AND expires_at > ?3)';
  const [changed] = await db.batch([
    db
      .prepare(`UPDATE users SET password_hash = ?4 WHERE id = ?1 AND ${unused}`)
      .bind(row.user_id, id, now, await hashPassword(password)),
    // A reset signs out every device: whoever knew the old password loses their session too.
    db.prepare(`DELETE FROM sessions WHERE user_id = ?1 AND ${unused}`).bind(row.user_id, id, now),
    db.prepare('UPDATE password_resets SET used_at = ?2 WHERE id = ?1 AND used_at IS NULL').bind(id, now),
  ]);
  if (!changed || changed.meta.changes === 0) return apiError(c, 400, 'invalid', BAD_TOKEN);
  return c.json({ ok: true as const });
});
