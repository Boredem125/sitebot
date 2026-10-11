export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
}

export interface MonthlyUsage extends TokenUsage {
  /** `YYYY-MM`, UTC. */
  month: string;
  messages: number;
}

/** True when `origin` is an http(s) origin whose host is one of `domains` or a subdomain of one. */
export function isOriginAllowed(origin: string | null | undefined, domains: string[]): boolean {
  if (!origin) return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  const host = url.hostname.toLowerCase();
  return domains.some((d) => {
    const domain = d.trim().toLowerCase();
    return domain !== '' && (host === domain || host.endsWith(`.${domain}`));
  });
}

/**
 * Fixed-window counter in D1. Counts this call, then reports whether the caller
 * is still within `limit` calls per `windowSec`.
 */
export async function rateLimit(
  db: D1Database,
  key: string,
  limit: number,
  windowSec: number,
  nowMs: number = Date.now(),
): Promise<{ ok: boolean; retryAfter: number }> {
  const nowSec = Math.floor(nowMs / 1000);
  const bucket = Math.floor(nowSec / windowSec);
  const windowEnd = (bucket + 1) * windowSec;
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (key, bucket, count, expires_at) VALUES (?1, ?2, 1, ?3)
       ON CONFLICT(key, bucket) DO UPDATE SET count = count + 1
       RETURNING count`,
    )
    .bind(`${key}:${windowSec}`, bucket, windowEnd * 1000)
    .first<{ count: number }>();
  const count = row?.count ?? 1;
  return count <= limit ? { ok: true, retryAfter: 0 } : { ok: false, retryAfter: windowEnd - nowSec };
}

const dayOf = (nowMs: number): string => new Date(nowMs).toISOString().slice(0, 10);

export async function monthlyUsage(
  db: D1Database,
  siteId: string,
  nowMs: number = Date.now(),
): Promise<MonthlyUsage> {
  const month = dayOf(nowMs).slice(0, 7);
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(messages), 0) AS messages,
              COALESCE(SUM(prompt_tokens), 0) AS promptTokens,
              COALESCE(SUM(completion_tokens), 0) AS completionTokens,
              COALESCE(SUM(cached_tokens), 0) AS cachedTokens
       FROM usage_daily WHERE site_id = ?1 AND day LIKE ?2`,
    )
    .bind(siteId, `${month}-%`)
    .first<Omit<MonthlyUsage, 'month'>>();
  return {
    month,
    messages: row?.messages ?? 0,
    promptTokens: row?.promptTokens ?? 0,
    completionTokens: row?.completionTokens ?? 0,
    cachedTokens: row?.cachedTokens ?? 0,
  };
}

/** Statement that adds one answered message and its tokens to today's row. Run it in a batch. */
export function recordUsageStatement(
  db: D1Database,
  siteId: string,
  usage: TokenUsage,
  nowMs: number = Date.now(),
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO usage_daily (site_id, day, messages, prompt_tokens, completion_tokens, cached_tokens)
       VALUES (?1, ?2, 1, ?3, ?4, ?5)
       ON CONFLICT(site_id, day) DO UPDATE SET
         messages = messages + 1,
         prompt_tokens = prompt_tokens + excluded.prompt_tokens,
         completion_tokens = completion_tokens + excluded.completion_tokens,
         cached_tokens = cached_tokens + excluded.cached_tokens`,
    )
    .bind(siteId, dayOf(nowMs), usage.promptTokens, usage.completionTokens, usage.cachedTokens);
}
