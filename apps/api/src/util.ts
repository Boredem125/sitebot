import type { Context } from 'hono';
import type { ApiError, ApiErrorCode } from '@sitebot/shared';

export const newId = (): string => crypto.randomUUID();

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function randomToken(bytes = 32): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
}

type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 413 | 429;

export function apiError(
  c: Context,
  status: ErrorStatus,
  code: ApiErrorCode,
  error: string,
  retryAfter?: number,
): Response {
  const body: ApiError = retryAfter === undefined ? { error, code } : { error, code, retryAfter };
  if (retryAfter !== undefined) c.header('Retry-After', String(retryAfter));
  return c.json(body, status);
}

export const clientIp = (c: Context): string => c.req.header('cf-connecting-ip') ?? 'unknown';
