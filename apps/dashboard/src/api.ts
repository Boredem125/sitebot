import type {
  ApiError,
  ApiErrorCode,
  AuthRequest,
  ConversationSummary,
  CrawlRequest,
  CreateSiteRequest,
  Message,
  QaRequest,
  ResetConfirm,
  ResetRequest,
  Site,
  SiteUsage,
  Source,
  UpdateSiteRequest,
  User,
} from '@sitebot/shared';

/** `network`: the request never got a response. `unknown`: a non-2xx body that was not an ApiError. */
export type RequestErrorCode = ApiErrorCode | 'network' | 'unknown';

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: RequestErrorCode;
  /** Seconds. */
  readonly retryAfter: number | undefined;

  constructor(status: number, code: RequestErrorCode, message: string, retryAfter?: number) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

// The session is an HttpOnly cookie, so the only way the app learns it has
// expired is a 401. The shell registers one handler to drop back to sign-in.
let onUnauthorized: (() => void) | null = null;

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorized = handler;
}

const API_CODES: readonly string[] = [
  'invalid',
  'unauthorized',
  'forbidden_origin',
  'not_found',
  'conflict',
  'rate_limited',
  'monthly_cap',
] satisfies ApiErrorCode[];

function isApiError(value: unknown): value is ApiError {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.error === 'string' && typeof v.code === 'string' && API_CODES.includes(v.code);
}

function parseSeconds(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.ceil(n) : undefined;
}

async function toError(res: Response): Promise<ApiRequestError> {
  const headerRetry = parseSeconds(res.headers.get('retry-after') ?? undefined);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  if (isApiError(body)) {
    return new ApiRequestError(res.status, body.code, body.error, parseSeconds(body.retryAfter) ?? headerRetry);
  }
  return new ApiRequestError(res.status, 'unknown', `Request failed (${res.status})`, headerRetry);
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  json?: unknown;
  form?: FormData;
  /** Sign-in calls answer 401 for bad credentials, which is not an expired session. */
  expectsSession?: boolean;
  signal?: AbortSignal;
}

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { method = 'GET', json, form, expectsSession = true, signal } = opts;
  const init: RequestInit = { method, credentials: 'same-origin', signal };
  if (json !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(json);
  } else if (form) {
    // No content-type here: the browser has to add the multipart boundary.
    init.body = form;
  }

  let res: Response;
  try {
    res = await fetch(path, init);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiRequestError(0, 'network', 'Could not reach the server. Check your connection.');
  }

  if (!res.ok) {
    const error = await toError(res);
    if (res.status === 401 && expectsSession) onUnauthorized?.();
    throw error;
  }
  try {
    return (await res.json()) as T;
  } catch {
    throw new ApiRequestError(res.status, 'unknown', 'The server sent a response that could not be read.');
  }
}

export const seg = (id: string): string => encodeURIComponent(id);

// ---------- auth ----------

export async function signup(body: AuthRequest): Promise<User> {
  const res = await request<{ user: User }>('/api/auth/signup', { method: 'POST', json: body, expectsSession: false });
  return res.user;
}

export async function login(body: AuthRequest): Promise<User> {
  const res = await request<{ user: User }>('/api/auth/login', { method: 'POST', json: body, expectsSession: false });
  return res.user;
}

export async function logout(): Promise<void> {
  await request<{ ok: true }>('/api/auth/logout', { method: 'POST', expectsSession: false });
}

export async function me(): Promise<User> {
  const res = await request<{ user: User }>('/api/auth/me', { expectsSession: false });
  return res.user;
}

/** Always resolves for a well-formed address: the server never says whether the account exists. */
export async function requestReset(body: ResetRequest): Promise<void> {
  await request<{ ok: true }>('/api/auth/reset/request', { method: 'POST', json: body, expectsSession: false });
}

/** Sets the new password. The caller is not signed in afterwards and logs in as usual. */
export async function confirmReset(body: ResetConfirm): Promise<void> {
  await request<{ ok: true }>('/api/auth/reset/confirm', { method: 'POST', json: body, expectsSession: false });
}

// ---------- sites ----------

export async function listSites(signal?: AbortSignal): Promise<Site[]> {
  const res = await request<{ sites: Site[] }>('/api/sites', { signal });
  return res.sites;
}

export async function createSite(body: CreateSiteRequest): Promise<Site> {
  const res = await request<{ site: Site }>('/api/sites', { method: 'POST', json: body });
  return res.site;
}

export function getSite(id: string, signal?: AbortSignal): Promise<{ site: Site; usage: SiteUsage }> {
  return request<{ site: Site; usage: SiteUsage }>(`/api/sites/${seg(id)}`, { signal });
}

export async function updateSite(id: string, body: UpdateSiteRequest): Promise<Site> {
  const res = await request<{ site: Site }>(`/api/sites/${seg(id)}`, { method: 'PATCH', json: body });
  return res.site;
}

/** Re-reads colours, font, and logo from the site and saves them. */
export async function detectBrand(id: string): Promise<Site> {
  const res = await request<{ site: Site }>(`/api/sites/${seg(id)}/brand`, { method: 'POST' });
  return res.site;
}

/** Removes the site and everything indexed or recorded for it. Cannot be undone. */
export async function deleteSite(id: string): Promise<void> {
  await request<{ ok: true }>(`/api/sites/${seg(id)}`, { method: 'DELETE' });
}

// ---------- sources ----------

export async function listSources(siteId: string, signal?: AbortSignal): Promise<Source[]> {
  const res = await request<{ sources: Source[] }>(`/api/sites/${seg(siteId)}/sources`, { signal });
  return res.sources;
}

export async function addCrawl(siteId: string, body: CrawlRequest): Promise<Source> {
  const res = await request<{ source: Source }>(`/api/sites/${seg(siteId)}/sources/crawl`, {
    method: 'POST',
    json: body,
  });
  return res.source;
}

export async function uploadFile(siteId: string, file: File): Promise<Source> {
  const form = new FormData();
  form.append('file', file);
  const res = await request<{ source: Source }>(`/api/sites/${seg(siteId)}/sources/upload`, {
    method: 'POST',
    form,
  });
  return res.source;
}

export async function addQa(siteId: string, body: QaRequest): Promise<Source> {
  const res = await request<{ source: Source }>(`/api/sites/${seg(siteId)}/sources/qa`, {
    method: 'POST',
    json: body,
  });
  return res.source;
}

/** Removes the source and its indexed content. */
export async function deleteSource(siteId: string, sourceId: string): Promise<void> {
  await request<{ ok: true }>(`/api/sites/${seg(siteId)}/sources/${seg(sourceId)}`, { method: 'DELETE' });
}

/** Crawl sources only. Answers 409 while the source is still queued or being indexed. */
export async function recrawlSource(siteId: string, sourceId: string): Promise<Source> {
  const res = await request<{ source: Source }>(`/api/sites/${seg(siteId)}/sources/${seg(sourceId)}/recrawl`, {
    method: 'POST',
  });
  return res.source;
}

// ---------- conversations ----------

export async function listConversations(siteId: string, signal?: AbortSignal): Promise<ConversationSummary[]> {
  const res = await request<{ conversations: ConversationSummary[] }>(`/api/sites/${seg(siteId)}/conversations`, {
    signal,
  });
  return res.conversations;
}

export async function getMessages(siteId: string, conversationId: string, signal?: AbortSignal): Promise<Message[]> {
  const res = await request<{ messages: Message[] }>(
    `/api/sites/${seg(siteId)}/conversations/${seg(conversationId)}`,
    { signal },
  );
  return res.messages;
}
