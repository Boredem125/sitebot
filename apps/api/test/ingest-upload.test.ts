import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import type { SourceRow } from '../src/db';
import { processQa, processUpload } from '../src/ingest/upload';
import { newId } from '../src/util';
import { makeEnv, seedSite } from './helpers';

// Starter-question generation has its own tests; here it would add a Groq call to every ingest.
vi.mock('../src/suggest', () => ({ refreshSuggestions: async () => {} }));

interface Ids {
  siteId: string;
  sourceId: string;
}

/** Inserts an upload source and, unless `body` is null, its R2 object. */
async function seedUpload(label: string, body: string | null, siteId?: string): Promise<Ids> {
  const site = siteId ?? (await seedSite(env.DB)).siteId;
  const sourceId = newId();
  const key = `${site}/${sourceId}/${label}`;
  if (body !== null) await env.UPLOADS.put(key, body);
  await env.DB.prepare(
    `INSERT INTO sources (id, site_id, kind, label, r2_key, created_at, updated_at)
     VALUES (?1, ?2, 'upload', ?3, ?4, 1, 1)`,
  )
    .bind(sourceId, site, label, key)
    .run();
  return { siteId: site, sourceId };
}

async function seedQa(question: string, answer: string, siteId?: string): Promise<Ids> {
  const site = siteId ?? (await seedSite(env.DB)).siteId;
  const sourceId = newId();
  await env.DB.prepare(
    `INSERT INTO sources (id, site_id, kind, label, content, created_at, updated_at)
     VALUES (?1, ?2, 'qa', ?3, ?4, 1, 1)`,
  )
    .bind(sourceId, site, question, answer)
    .run();
  return { siteId: site, sourceId };
}

async function sourceRow(sourceId: string): Promise<SourceRow> {
  const row = await env.DB.prepare('SELECT * FROM sources WHERE id = ?1').bind(sourceId).first<SourceRow>();
  if (!row) throw new Error('source not found');
  return row;
}

async function chunks(ids: Ids): Promise<{ url: string; title: string; content: string }[]> {
  const { results } = await env.DB.prepare(
    'SELECT url, title, content FROM chunks WHERE site_id = ?1 AND source_id = ?2 ORDER BY position',
  )
    .bind(ids.siteId, ids.sourceId)
    .all<{ url: string; title: string; content: string }>();
  return results;
}

describe('processUpload', () => {
  it('indexes a .txt file', async () => {
    const t = makeEnv();
    const ids = await seedUpload('notes.txt', 'Opening hours are nine to five.\n\nClosed on Sundays.');
    const toMarkdown = vi.spyOn(t.ai, 'toMarkdown');

    await processUpload(t.env, { type: 'upload', ...ids });

    expect(await sourceRow(ids.sourceId)).toMatchObject({ status: 'ready', error: null, pages: 1 });
    expect((await sourceRow(ids.sourceId)).updated_at).toBeGreaterThan(1);
    expect(await chunks(ids)).toEqual([
      { url: '', title: 'notes.txt', content: 'Opening hours are nine to five.\nClosed on Sundays.' },
    ]);
    expect(toMarkdown).not.toHaveBeenCalled();
    expect([...t.vectorize.vectors.values()].map((v) => v.namespace)).toEqual([ids.siteId]);
  });

  it('indexes a .md file, whatever the case of the extension', async () => {
    const t = makeEnv();
    const ids = await seedUpload('README.MD', '# Returns\n\nSend items back within 30 days.');

    await processUpload(t.env, { type: 'upload', ...ids });

    expect(await sourceRow(ids.sourceId)).toMatchObject({ status: 'ready', pages: 1 });
    expect((await chunks(ids))[0]!.content).toBe('# Returns\nSend items back within 30 days.');
  });

  it('converts a .pdf with Workers AI toMarkdown', async () => {
    const t = makeEnv();
    // The fake toMarkdown returns the blob's bytes as text, so plain text stands in for a PDF.
    const ids = await seedUpload('manual.pdf', 'Chapter one. How to assemble the desk.');
    const toMarkdown = vi.spyOn(t.ai, 'toMarkdown');

    await processUpload(t.env, { type: 'upload', ...ids });

    expect(toMarkdown).toHaveBeenCalledTimes(1);
    const files = toMarkdown.mock.calls[0]![0];
    expect(files).toHaveLength(1);
    expect(files[0]!.name).toBe('manual.pdf');
    expect(files[0]!.blob.type).toBe('application/pdf');
    expect(await sourceRow(ids.sourceId)).toMatchObject({ status: 'ready', error: null, pages: 1 });
    expect(await chunks(ids)).toEqual([
      { url: '', title: 'manual.pdf', content: 'Chapter one. How to assemble the desk.' },
    ]);
  });

  it('accepts a single object from toMarkdown as well as an array', async () => {
    const t = makeEnv();
    const ids = await seedUpload('one.pdf', 'ignored');
    vi.spyOn(t.ai, 'toMarkdown').mockResolvedValue({ name: 'one.pdf', data: 'Single result text.' } as never);

    await processUpload(t.env, { type: 'upload', ...ids });

    expect(await sourceRow(ids.sourceId)).toMatchObject({ status: 'ready', pages: 1 });
    expect((await chunks(ids))[0]!.content).toBe('Single result text.');
  });

  it('reports a PDF that cannot be converted', async () => {
    const t = makeEnv();
    const failed = await seedUpload('scan.pdf', 'x');
    vi.spyOn(t.ai, 'toMarkdown').mockResolvedValueOnce([{ name: 'scan.pdf', format: 'error', error: 'bad' }] as never);
    await processUpload(t.env, { type: 'upload', ...failed });
    expect(await sourceRow(failed.sourceId)).toMatchObject({ status: 'error', error: 'Could not read this PDF' });

    const thrown = await seedUpload('crash.pdf', 'x');
    vi.spyOn(t.ai, 'toMarkdown').mockRejectedValueOnce(new Error('conversion service down'));
    await processUpload(t.env, { type: 'upload', ...thrown });
    expect(await sourceRow(thrown.sourceId)).toMatchObject({ status: 'error', error: 'Could not read this PDF' });
    expect(await chunks(thrown)).toEqual([]);
  });

  it('reports a missing object, an empty file, and an unsupported type', async () => {
    const t = makeEnv();
    const missing = await seedUpload('lost.txt', null);
    await processUpload(t.env, { type: 'upload', ...missing });
    expect(await sourceRow(missing.sourceId)).toMatchObject({ status: 'error', error: 'Uploaded file not found' });

    const empty = await seedUpload('blank.txt', '  \n\n ');
    await processUpload(t.env, { type: 'upload', ...empty });
    expect(await sourceRow(empty.sourceId)).toMatchObject({ status: 'error', error: 'No text found in this file' });

    const odd = await seedUpload('photo.png', 'not text');
    await processUpload(t.env, { type: 'upload', ...odd });
    expect(await sourceRow(odd.sourceId)).toMatchObject({ status: 'error', error: 'Unsupported file type' });

    expect(t.ai.calls).toEqual([]);
    expect(t.vectorize.vectors.size).toBe(0);
  });

  it('does nothing for a source that belongs to another site', async () => {
    const t = makeEnv();
    const ids = await seedUpload('notes.txt', 'Some text.');
    const other = await seedSite(env.DB);

    await processUpload(t.env, { type: 'upload', siteId: other.siteId, sourceId: ids.sourceId });

    expect((await sourceRow(ids.sourceId)).status).toBe('pending');
    expect(t.ai.calls).toEqual([]);
  });
});

describe('processQa', () => {
  it('indexes the pair as one chunk', async () => {
    const t = makeEnv();
    const ids = await seedQa('Do you ship abroad?', 'Yes, to most countries.');

    await processQa(t.env, { type: 'qa', ...ids });

    expect(await sourceRow(ids.sourceId)).toMatchObject({ status: 'ready', error: null, pages: 1 });
    expect(await chunks(ids)).toEqual([
      { url: '', title: 'Do you ship abroad?', content: 'Q: Do you ship abroad?\nA: Yes, to most countries.' },
    ]);
  });

  it('keeps several Q&As and uploads of one site apart although all use url ""', async () => {
    const t = makeEnv();
    const first = await seedQa('First question?', 'First answer.');
    const second = await seedQa('Second question?', 'Second answer.', first.siteId);
    const upload = await seedUpload('notes.txt', 'Upload text.', first.siteId);

    await processQa(t.env, { type: 'qa', ...first });
    await processQa(t.env, { type: 'qa', ...second });
    await processUpload(t.env, { type: 'upload', ...upload });
    // Running a job again changes nothing and costs no embedding.
    await processQa(t.env, { type: 'qa', ...first });

    expect((await chunks(first)).map((c) => c.content)).toEqual(['Q: First question?\nA: First answer.']);
    expect((await chunks(second)).map((c) => c.content)).toEqual(['Q: Second question?\nA: Second answer.']);
    expect((await chunks(upload)).map((c) => c.content)).toEqual(['Upload text.']);
    expect(t.vectorize.vectors.size).toBe(3);
    expect(t.ai.calls).toHaveLength(3);
  });
});
