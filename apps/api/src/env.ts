export type IngestJob =
  | { type: 'crawl'; siteId: string; sourceId: string }
  | { type: 'page'; siteId: string; sourceId: string; url: string }
  | { type: 'upload'; siteId: string; sourceId: string }
  | { type: 'qa'; siteId: string; sourceId: string };

export interface Env {
  DB: D1Database;
  VECTORIZE: Vectorize;
  AI: Ai;
  UPLOADS: R2Bucket;
  INGEST_QUEUE: Queue<IngestJob>;
  /** Cloudflare Browser Run, for pages that only show their text after JavaScript runs. Optional. */
  BROWSER?: BrowserRun;
  /** Secret. Never log it or return it to a client. */
  GROQ_API_KEY: string;
  /** Secret, optional. More Groq keys, comma-separated, tried when the first is rate limited. */
  GROQ_API_KEYS?: string;
  DEFAULT_MODEL: string;
  /** Optional. Model to fall back to when every key is rate limited on the site's model. */
  FALLBACK_MODEL?: string;
  /** Secret, optional. Resend API key for password reset mail. Without it no mail is sent. */
  RESEND_API_KEY?: string;
  /** Optional. From address for mail, e.g. `Sitebot <no-reply@example.com>`. */
  MAIL_FROM?: string;
  /** Optional. Public URL of the dashboard, used to build links in mail. */
  APP_URL?: string;
  /** Comma-separated origins allowed to call /api, e.g. `https://app.example.com`. */
  DASHBOARD_ORIGIN: string;
}

export const EMBED_MODEL = '@cf/baai/bge-m3';
export const EMBED_DIMENSIONS = 1024;
export const CRAWLER_USER_AGENT = 'SitebotCrawler/1.0';
