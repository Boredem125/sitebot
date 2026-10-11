import type { Env, IngestJob } from '../env';
import { indexDocument, loadSource, setSourceStatus } from './index-doc';

type UploadJob = Extract<IngestJob, { type: 'upload' }>;
type QaJob = Extract<IngestJob, { type: 'qa' }>;

/** Extracts the text of an uploaded file from R2 and indexes it as one document. */
export async function processUpload(env: Env, job: UploadJob): Promise<void> {
  const { siteId, sourceId } = job;
  const source = await loadSource(env, siteId, sourceId);
  if (!source || source.kind !== 'upload') return;
  await setSourceStatus(env, siteId, sourceId, 'processing');
  const fail = (message: string): Promise<void> =>
    setSourceStatus(env, siteId, sourceId, 'error', message);

  const object = source.r2_key ? await env.UPLOADS.get(source.r2_key) : null;
  if (!object) return fail('Uploaded file not found');

  const name = source.label;
  const extension = /\.[a-z0-9]+$/i.exec(name)?.[0].toLowerCase() ?? '';
  let text: string;
  if (extension === '.txt' || extension === '.md') {
    text = await object.text();
  } else if (extension === '.pdf') {
    try {
      const blob = new Blob([await object.arrayBuffer()], { type: 'application/pdf' });
      const converted = await env.AI.toMarkdown([{ name, blob }]);
      const first = Array.isArray(converted) ? converted[0] : converted;
      if (!first || first.format === 'error') return fail('Could not read this PDF');
      text = first.data;
    } catch {
      return fail('Could not read this PDF');
    }
  } else {
    return fail('Unsupported file type');
  }

  const result = await indexDocument(env, { siteId, sourceId, url: '', title: name, text });
  if (result === 'empty') return fail('No text found in this file');
  await setSourceStatus(env, siteId, sourceId, 'ready', null, 1);
}

/** Indexes one question-and-answer pair entered in the dashboard. */
export async function processQa(env: Env, job: QaJob): Promise<void> {
  const { siteId, sourceId } = job;
  const source = await loadSource(env, siteId, sourceId);
  if (!source || source.kind !== 'qa') return;
  const text = `Q: ${source.label}\nA: ${source.content ?? ''}`;
  await indexDocument(env, { siteId, sourceId, url: '', title: source.label, text });
  await setSourceStatus(env, siteId, sourceId, 'ready', null, 1);
}
