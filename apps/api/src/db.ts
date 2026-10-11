import type { Site, Source, SourceKind, SourceStatus } from '@sitebot/shared';

export interface SiteRow {
  id: string;
  user_id: string;
  name: string;
  public_key: string;
  domains: string;
  greeting: string;
  color: string;
  position: string;
  instructions: string;
  model: string | null;
  monthly_cap: number;
  created_at: number;
  background: string | null;
  text_color: string | null;
  font: string | null;
  logo_url: string | null;
  brand_locked: number;
  suggested_questions: string;
  lead_capture: number;
}

export interface SourceRow {
  id: string;
  site_id: string;
  kind: SourceKind;
  label: string;
  r2_key: string | null;
  content: string | null;
  meta: string;
  status: SourceStatus;
  error: string | null;
  pages: number;
  created_at: number;
  updated_at: number;
}

export interface ChunkRow {
  id: string;
  site_id: string;
  source_id: string;
  url: string;
  title: string;
  content: string;
  doc_hash: string;
  position: number;
  created_at: number;
}

export function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export function toSite(row: SiteRow): Site {
  return {
    id: row.id,
    name: row.name,
    publicKey: row.public_key,
    domains: parseJson<string[]>(row.domains, []),
    greeting: row.greeting,
    color: row.color,
    position: row.position === 'left' ? 'left' : 'right',
    background: row.background,
    textColor: row.text_color,
    font: row.font,
    logoUrl: row.logo_url,
    suggestedQuestions: parseJson<string[]>(row.suggested_questions, []),
    leadCapture: row.lead_capture === 1,
    instructions: row.instructions,
    monthlyCap: row.monthly_cap,
    createdAt: row.created_at,
  };
}

export function toSource(row: SourceRow): Source {
  return {
    id: row.id,
    siteId: row.site_id,
    kind: row.kind,
    label: row.label,
    status: row.status,
    error: row.error,
    pages: row.pages,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function siteByPublicKey(db: D1Database, publicKey: string): Promise<SiteRow | null> {
  return db.prepare('SELECT * FROM sites WHERE public_key = ?1').bind(publicKey).first<SiteRow>();
}

/** Tenant-scoped lookup: returns null unless the site belongs to `userId`. */
export function siteForUser(db: D1Database, siteId: string, userId: string): Promise<SiteRow | null> {
  return db
    .prepare('SELECT * FROM sites WHERE id = ?1 AND user_id = ?2')
    .bind(siteId, userId)
    .first<SiteRow>();
}
