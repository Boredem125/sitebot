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
  /** Secret. Never log it or return it to a client. */
  GROQ_API_KEY: string;
  DEFAULT_MODEL: string;
  /** Comma-separated origins allowed to call /api, e.g. `https://app.example.com`. */
  DASHBOARD_ORIGIN: string;
}

export const EMBED_MODEL = '@cf/baai/bge-m3';
export const EMBED_DIMENSIONS = 1024;
export const CRAWLER_USER_AGENT = 'SitebotCrawler/1.0';
