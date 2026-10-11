import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import type { ChunkRow } from '../src/db';
import { deleteChunks, indexDocument } from '../src/ingest/index-doc';
import { newId } from '../src/util';
import { makeEnv, seedSite } from './helpers';

async function seedSource(siteId: string): Promise<string> {
  const id = newId();
  await env.DB.prepare(
    `INSERT INTO sources (id, site_id, kind, label, created_at, updated_at)
     VALUES (?1, ?2, 'qa', 'Question?', ?3, ?3)`,
  )
    .bind(id, siteId, Date.now())
    .run();
  return id;
}

async function chunksOf(siteId: string, sourceId: string, url = ''): Promise<ChunkRow[]> {
  const { results } = await env.DB.prepare(
    'SELECT * FROM chunks WHERE site_id = ?1 AND source_id = ?2 AND url = ?3 ORDER BY position',
  )
    .bind(siteId, sourceId, url)
    .all<ChunkRow>();
  return results;
}

const paragraphs = (count: number, tag: string): string =>
  Array.from({ length: count }, (_, i) => `${tag} paragraph ${i}. `.repeat(60).trim()).join('\n\n');

describe('indexDocument', () => {
  it('indexes a document, then reports unchanged without embedding again', async () => {
    const t = makeEnv();
    const { siteId } = await seedSite(env.DB);
    const sourceId = await seedSource(siteId);
    const doc = { siteId, sourceId, url: 'https://example.com/a', title: 'Page A', text: 'Hello world.' };

    expect(await indexDocument(t.env, doc)).toBe('indexed');
    expect(t.ai.calls).toHaveLength(1);
    expect(t.ai.calls[0]).toEqual({ model: '@cf/baai/bge-m3', input: { text: ['Hello world.'] } });

    const rows = await chunksOf(siteId, sourceId, doc.url);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title: 'Page A', content: 'Hello world.', position: 0, url: doc.url });
    expect(rows[0]!.doc_hash).toMatch(/^[0-9a-f]{64}$/);

    // The vector id is the chunk id, and the vector lives in the site's namespace.
    expect([...t.vectorize.vectors.keys()]).toEqual([rows[0]!.id]);
    const vector = t.vectorize.vectors.get(rows[0]!.id)!;
    expect(vector.namespace).toBe(siteId);
    expect(vector.values).toHaveLength(1024);

    expect(await indexDocument(t.env, doc)).toBe('unchanged');
    expect(t.ai.calls).toHaveLength(1);
    expect((await chunksOf(siteId, sourceId, doc.url)).map((r) => r.id)).toEqual([rows[0]!.id]);
  });

  it('replaces old chunks and vectors when the content changes', async () => {
    const t = makeEnv();
    const { siteId } = await seedSite(env.DB);
    const sourceId = await seedSource(siteId);
    const doc = { siteId, sourceId, url: 'https://example.com/a', title: 'Page A', text: paragraphs(3, 'old') };

    expect(await indexDocument(t.env, doc)).toBe('indexed');
    const before = await chunksOf(siteId, sourceId, doc.url);
    expect(before.length).toBeGreaterThan(1);

    expect(await indexDocument(t.env, { ...doc, text: 'Short new text.' })).toBe('indexed');
    const after = await chunksOf(siteId, sourceId, doc.url);
    expect(after.map((r) => r.content)).toEqual(['Short new text.']);
    expect([...t.vectorize.vectors.keys()]).toEqual([after[0]!.id]);
    for (const old of before) expect(t.vectorize.vectors.has(old.id)).toBe(false);

    // A new title alone also counts as a change.
    expect(await indexDocument(t.env, { ...doc, title: 'Renamed', text: 'Short new text.' })).toBe('indexed');
    expect((await chunksOf(siteId, sourceId, doc.url))[0]!.title).toBe('Renamed');
  });

  it("returns 'empty' for text with no content and removes what was there", async () => {
    const t = makeEnv();
    const { siteId } = await seedSite(env.DB);
    const sourceId = await seedSource(siteId);
    const doc = { siteId, sourceId, url: 'https://example.com/a', title: 'T', text: 'Something.' };

    expect(await indexDocument(t.env, { ...doc, text: ' \n ' })).toBe('empty');
    expect(t.ai.calls).toHaveLength(0);

    await indexDocument(t.env, doc);
    expect(await indexDocument(t.env, { ...doc, text: '' })).toBe('empty');
    expect(await chunksOf(siteId, sourceId, doc.url)).toEqual([]);
    expect(t.vectorize.vectors.size).toBe(0);
  });

  it('keeps documents apart by source and by url', async () => {
    const t = makeEnv();
    const { siteId } = await seedSite(env.DB);
    const first = await seedSource(siteId);
    const second = await seedSource(siteId);

    // Two uploads or Q&As in one site both use url ''.
    await indexDocument(t.env, { siteId, sourceId: first, url: '', title: 'One', text: 'First text.' });
    await indexDocument(t.env, { siteId, sourceId: second, url: '', title: 'Two', text: 'Second text.' });
    await indexDocument(t.env, { siteId, sourceId: first, url: 'https://example.com/b', title: 'B', text: 'Page b.' });

    await indexDocument(t.env, { siteId, sourceId: first, url: '', title: 'One', text: 'First text, edited.' });
    expect((await chunksOf(siteId, first)).map((r) => r.content)).toEqual(['First text, edited.']);
    expect((await chunksOf(siteId, second)).map((r) => r.content)).toEqual(['Second text.']);
    expect(await chunksOf(siteId, first, 'https://example.com/b')).toHaveLength(1);
    expect(t.vectorize.vectors.size).toBe(3);
  });

  it('writes large documents in batches of at most 100', async () => {
    const t = makeEnv();
    const { siteId } = await seedSite(env.DB);
    const sourceId = await seedSource(siteId);
    const upsert = vi.spyOn(t.vectorize, 'upsert');
    const deleteByIds = vi.spyOn(t.vectorize, 'deleteByIds');
    const doc = { siteId, sourceId, url: '', title: 'Big', text: paragraphs(230, 'big') };

    expect(await indexDocument(t.env, doc)).toBe('indexed');
    const rows = await chunksOf(siteId, sourceId);
    expect(rows.length).toBeGreaterThan(200);
    expect(rows.map((r) => r.position)).toEqual(rows.map((_, i) => i));
    expect(t.vectorize.vectors.size).toBe(rows.length);
    expect(upsert.mock.calls.length).toBeGreaterThanOrEqual(3);
    for (const [vectors] of upsert.mock.calls) expect(vectors.length).toBeLessThanOrEqual(100);

    expect(await indexDocument(t.env, { ...doc, text: 'Now tiny.' })).toBe('indexed');
    expect(deleteByIds.mock.calls.length).toBeGreaterThanOrEqual(3);
    for (const [ids] of deleteByIds.mock.calls) expect(ids.length).toBeLessThanOrEqual(100);
    expect(await chunksOf(siteId, sourceId)).toHaveLength(1);
    expect(t.vectorize.vectors.size).toBe(1);
  });

  it('keeps the old chunks when embedding fails', async () => {
    const t = makeEnv();
    const { siteId } = await seedSite(env.DB);
    const sourceId = await seedSource(siteId);
    const doc = { siteId, sourceId, url: '', title: 'T', text: 'Original.' };
    await indexDocument(t.env, doc);

    vi.spyOn(t.ai, 'run').mockRejectedValueOnce(new Error('model down'));
    await expect(indexDocument(t.env, { ...doc, text: 'Changed.' })).rejects.toThrow('model down');
    expect((await chunksOf(siteId, sourceId)).map((r) => r.content)).toEqual(['Original.']);
    expect(t.vectorize.vectors.size).toBe(1);
  });

  it('re-indexes a document whose previous write stopped part-way', async () => {
    const t = makeEnv();
    const { siteId } = await seedSite(env.DB);
    const sourceId = await seedSource(siteId);
    const doc = { siteId, sourceId, url: '', title: 'T', text: paragraphs(4, 'part') };
    await indexDocument(t.env, doc);
    const full = await chunksOf(siteId, sourceId);
    expect(full.length).toBeGreaterThan(2);

    // Position 0 is written last, so its absence marks an unfinished write.
    await env.DB.prepare('DELETE FROM chunks WHERE id = ?1 AND site_id = ?2').bind(full[0]!.id, siteId).run();
    expect(await indexDocument(t.env, doc)).toBe('indexed');
    const again = await chunksOf(siteId, sourceId);
    expect(again.map((r) => r.content)).toEqual(full.map((r) => r.content));
    for (const row of again) expect(t.vectorize.vectors.has(row.id)).toBe(true);
    for (const old of full.slice(1)) expect(t.vectorize.vectors.has(old.id)).toBe(false);
  });
});

describe('deleteChunks', () => {
  it('removes chunks from Vectorize and D1, and only for the given site in D1', async () => {
    const t = makeEnv();
    const a = await seedSite(env.DB);
    const b = await seedSite(env.DB);
    const sourceA = await seedSource(a.siteId);
    const sourceB = await seedSource(b.siteId);
    await indexDocument(t.env, { siteId: a.siteId, sourceId: sourceA, url: '', title: 'A', text: 'Site a.' });
    await indexDocument(t.env, { siteId: b.siteId, sourceId: sourceB, url: '', title: 'B', text: 'Site b.' });
    const idA = (await chunksOf(a.siteId, sourceA))[0]!.id;
    const idB = (await chunksOf(b.siteId, sourceB))[0]!.id;

    // A delete issued for site a must not remove site b's row, even given site b's chunk id.
    // (Run against a throwaway Vectorize: that side deletes by id alone.)
    await deleteChunks({ ...t.env, VECTORIZE: makeEnv().env.VECTORIZE }, a.siteId, [idB]);
    expect((await chunksOf(b.siteId, sourceB)).map((r) => r.id)).toEqual([idB]);

    await deleteChunks(t.env, a.siteId, [idA]);
    expect(await chunksOf(a.siteId, sourceA)).toEqual([]);
    expect(t.vectorize.vectors.has(idA)).toBe(false);
    expect(t.vectorize.vectors.has(idB)).toBe(true);

    await deleteChunks(t.env, a.siteId, []);
  });
});
