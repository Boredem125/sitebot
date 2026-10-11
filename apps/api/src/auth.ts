import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { User } from '@sitebot/shared';
import type { Env } from './env';
import { apiError, randomToken, sha256Hex } from './util';

export type AppEnv = { Bindings: Env; Variables: { user: User } };

// The Workers runtime rejects PBKDF2 iteration counts above 100,000.
const ITERATIONS = 100_000;
const SALT_BYTES = 16;
const KEY_BYTES = 32;

export const SESSION_COOKIE = 'sb_session';
const SESSION_TTL_SEC = 30 * 24 * 60 * 60;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The trimmed, lower-cased address, or null when the value is not a plausible email. */
export function parseEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return email.length <= 254 && EMAIL.test(email) ? email : null;
}

// One rule for signup and password reset, so a reset can never set a password signup would refuse.
export const PASSWORD_RULE = 'Password must be 8 to 200 characters';

export const isValidPassword = (value: unknown): value is string =>
  typeof value === 'string' && value.length >= 8 && value.length <= 200;

const toBase64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));

const fromBase64 = (text: string): Uint8Array => Uint8Array.from(atob(text), (ch) => ch.charCodeAt(0));

const formatHash = (salt: Uint8Array, hash: Uint8Array): string =>
  `pbkdf2$${ITERATIONS}$${toBase64(salt)}$${toBase64(hash)}`;

/**
 * Well-formed hash that no password matches. Login verifies against it when the
 * email is unknown, so both failure paths cost one PBKDF2 run.
 */
export const DUMMY_PASSWORD_HASH = formatHash(new Uint8Array(SALT_BYTES), new Uint8Array(KEY_BYTES));

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    key,
    KEY_BYTES * 8,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  return formatHash(salt, await derive(password, salt, ITERATIONS));
}

/** False for a wrong password and for any stored value that is not one of our hashes. Never throws. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const [scheme, rounds, saltText, hashText, ...rest] = stored.split('$');
    if (scheme !== 'pbkdf2' || !rounds || !saltText || !hashText || rest.length > 0) return false;
    const iterations = Number(rounds);
    if (!Number.isInteger(iterations) || iterations < 1 || iterations > ITERATIONS) return false;
    const salt = fromBase64(saltText);
    const expected = fromBase64(hashText);
    // timingSafeEqual throws on a length mismatch, so rule that out first.
    if (salt.length === 0 || expected.length !== KEY_BYTES) return false;
    const actual = await derive(password, salt, iterations);
    return crypto.subtle.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

const cookieOptions = { httpOnly: true, secure: true, sameSite: 'Lax', path: '/' } as const;

/** Starts a session for `userId` and sets the cookie. Only the token's hash is stored. */
export async function createSession(c: Context<AppEnv>, userId: string): Promise<void> {
  const token = randomToken(32);
  const now = Date.now();
  const db = c.env.DB;
  await db.batch([
    // Sweep this user's expired rows here so the table needs no separate cleanup job.
    db.prepare('DELETE FROM sessions WHERE user_id = ?1 AND expires_at <= ?2').bind(userId, now),
    db
      .prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?1, ?2, ?3)')
      .bind(await sha256Hex(token), userId, now + SESSION_TTL_SEC * 1000),
  ]);
  setCookie(c, SESSION_COOKIE, token, { ...cookieOptions, maxAge: SESSION_TTL_SEC });
}

export async function destroySession(c: Context<AppEnv>): Promise<void> {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) {
    await c.env.DB.prepare('DELETE FROM sessions WHERE id = ?1').bind(await sha256Hex(token)).run();
  }
  deleteCookie(c, SESSION_COOKIE, cookieOptions);
}

export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE);
  const user = token
    ? await c.env.DB.prepare(
        `SELECT u.id AS id, u.email AS email
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.id = ?1 AND s.expires_at > ?2`,
      )
        .bind(await sha256Hex(token), Date.now())
        .first<User>()
    : null;
  if (!user) return apiError(c, 401, 'unauthorized', 'Sign in required');
  c.set('user', { id: user.id, email: user.email });
  await next();
};

const trimOrigin = (origin: string): string => origin.trim().replace(/\/+$/, '').toLowerCase();

/**
 * CSRF defence for the cookie-authenticated API: a browser always sends Origin on
 * cross-site writes, so a write whose Origin is neither ours nor the dashboard's is
 * refused. Requests without Origin come from non-browser clients, which carry no
 * ambient cookies to abuse.
 */
export const originGuard: MiddlewareHandler<AppEnv> = async (c, next) => {
  const method = c.req.method.toUpperCase();
  const origin = c.req.header('origin');
  if (method !== 'GET' && method !== 'HEAD' && origin !== undefined) {
    const allowed = [new URL(c.req.url).origin, ...(c.env.DASHBOARD_ORIGIN ?? '').split(',')]
      .map(trimOrigin)
      .filter((o) => o !== '');
    if (!allowed.includes(trimOrigin(origin))) {
      return apiError(c, 403, 'forbidden_origin', 'Origin not allowed');
    }
  }
  await next();
};
