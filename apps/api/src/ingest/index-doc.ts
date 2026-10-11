import type { SourceStatus } from '@sitebot/shared';
import type { SourceRow } from '../db';
import type { Env } from '../env';
import { newId, sha256Hex } from '../util';
import { chunkText } from './chunk';
import { embedTexts } from './embed';

/** Limit for Vectorize upsert/deleteByIds calls and for statements in one D1 batch. */
export const BATCH = 100;

export function batches<T>(items: T[], size: number = BATCH): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Tenant-scoped lookup: null unless the source belongs to `siteId`. */
export function loadSource(env: Env, siteId: string, sourceId: string): Promise<SourceRow | null> {
  return env.DB.prepare('SELECT * FROM sources WHERE id = ?1 AND site_id = ?2')
    .bind(sourceId, siteId)
    .first<SourceRow>();
}

/** Sets status and error (and `pages` when given), and bumps updated_at. */
export async function setSourceStatus(
  env: Env,
  siteId: string,
  sourceId: string,
  status: SourceStatus,
  error: string | null = null,
  pages?: number,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE sources SET status = ?3, error = ?4, pages = COALESCE(?5, pages), updated_at = ?6
     WHERE id = ?1 AND site_id = ?2`,
  )
    .bind(sourceId, siteId, status, error, pages ?? null, Date.now())
    .run();
}

/**
 * Chunks, embeds, and stores one document, replacing whatever was indexed before for the
 * same (source, url). Skips all work when the content hash has not changed.
 */
export async function indexDocument(
  env: Env,
  doc: { siteId: string; sourceId: string; url: string; title: string; text: string },
): Promise<'indexed' | 'unchanged' | 'empty'> {
  const docHash = await sha256Hex(doc.title + '\n' + doc.text);
  const { results: old } = await env.DB.prepare(
    'SELECT id, doc_hash, position FROM chunks WHERE site_id = ?1 AND source_id = ?2 AND url = ?3',
  )
    .bind(doc.siteId, doc.sourceId, doc.url)
    .all<{ id: string; doc_hash: string; position: number }>();
  // Position 0 is written last (see below), so its presence proves the previous run finished.
  if (old.some((row) => row.position === 0 && row.doc_hash === docHash)) return 'unchanged';

  // Embed before deleting anything: if the model call fails, the old chunks keep answering.
  const texts = chunkText(doc.text);
  const vectors = await embedTexts(env, texts);

  const oldIds = old.map((row) => row.id);
  await deleteChunks(env, doc.siteId, oldIds);
  if (texts.length === 0) return 'empty';

  const now = Date.now();
  const rows = texts.map((content, position) => ({ id: newId(), content, position }));
  for (const group of batches(rows)) {
    await env.VECTORIZE.upsert(
      group.map((row) => ({ id: row.id, values: vectors[row.position]!, namespace: doc.siteId })),
    );
  }
  // Vectors first, and D1 batches in reverse order: a crash part-way leaves no row at
  // position 0, so the retry re-indexes instead of reporting 'unchanged' on half a document.
  const insert = env.DB.prepare(
    `INSERT INTO chunks (id, site_id, source_id, url, title, content, doc_hash, position, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  );
  try {
    for (const group of batches(rows).reverse()) {
      await env.DB.batch(
        group.map((row) =>
          insert.bind(
            row.id,
            doc.siteId,
            doc.sourceId,
            doc.url,
            doc.title,
            row.content,
            docHash,
            row.position,
            now,
          ),
        ),
      );
    }
  } catch (err) {
    // Typically the source was deleted while we were embedding, so the insert fails on its
    // foreign key. The vectors just written would have no row naming them: take them back out,
    // along with any rows that did get in, then let the job fail.
    await deleteChunks(env, doc.siteId, rows.map((row) => row.id)).catch(() => {});
    throw err;
  }
  return 'indexed';
}

/**
 * Removes chunks from Vectorize and D1. Vectorize deletes by id alone, so pass only ids that
 * were read with a site_id filter.
 */
export async function deleteChunks(env: Env, siteId: string, ids: string[]): Promise<void> {
  const remove = env.DB.prepare('DELETE FROM chunks WHERE id = ?1 AND site_id = ?2');
  for (const group of batches(ids)) {
    await env.VECTORIZE.deleteByIds(group);
    await env.DB.batch(group.map((id) => remove.bind(id, siteId)));
  }
}
