import type { Env, IngestJob } from './env';
import { abandonPage, crawlPage, startCrawl } from './ingest/crawl';
import { batches, setSourceStatus } from './ingest/index-doc';
import { processQa, processUpload } from './ingest/upload';

/** Deliveries per message: the first plus `max_retries` (3) from wrangler.jsonc. */
const MAX_ATTEMPTS = 4;
const RETRY_DELAY_SEC = 30;
export const DEAD_LETTER_QUEUE = 'sitebot-ingest-dlq';

function runJob(env: Env, job: IngestJob): Promise<void> {
  switch (job.type) {
    case 'crawl':
      return startCrawl(env, job);
    case 'page':
      return crawlPage(env, job);
    case 'upload':
      return processUpload(env, job);
    case 'qa':
      return processQa(env, job);
  }
}

/** Records a job that will not be delivered again, so its source does not stay 'processing'. */
function giveUp(env: Env, job: IngestJob): Promise<void> {
  if (job.type === 'page') return abandonPage(env, job);
  return setSourceStatus(env, job.siteId, job.sourceId, 'error', 'Processing failed, try again');
}

/**
 * Jobs Cloudflare gave up delivering land here. That happens when a whole invocation dies
 * (CPU limit, an exception outside our try/catch, a deploy mid-batch) often enough to use up
 * the retries: our own last-attempt handling never ran, so nothing recorded the failure and
 * a crawl would wait on its 'pending' pages forever. Recording it lets the crawl finish.
 */
async function handleDeadLetters(batch: MessageBatch<IngestJob>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    const job = message.body;
    try {
      console.error('ingest job dead-lettered', { type: job?.type, siteId: job?.siteId, sourceId: job?.sourceId });
      await giveUp(env, job);
      message.ack();
    } catch {
      message.retry({ delaySeconds: RETRY_DELAY_SEC });
    }
  }
}

export async function handleQueue(
  batch: MessageBatch<IngestJob>,
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  if (batch.queue === DEAD_LETTER_QUEUE) return handleDeadLetters(batch, env);

  // One at a time: page jobs of the same crawl share a frontier and its page cap.
  for (const message of batch.messages) {
    const job = message.body;
    // Ids only. Job URLs and page content never go to the logs.
    const ref = { type: job?.type, siteId: job?.siteId, sourceId: job?.sourceId };
    try {
      await runJob(env, job);
      message.ack();
    } catch (err) {
      const reason = err instanceof Error ? err.message.slice(0, 200) : 'unknown error';
      console.error('ingest job failed', { ...ref, attempt: message.attempts, reason });
      if (message.attempts < MAX_ATTEMPTS) {
        // Back off: an outage of Workers AI or Vectorize usually outlasts an instant retry.
        message.retry({ delaySeconds: RETRY_DELAY_SEC * message.attempts });
        continue;
      }
      try {
        await giveUp(env, job);
        message.ack();
      } catch {
        message.retry();
      }
    }
  }
}

/** Weekly maintenance: re-crawl every crawl source and purge expired rows. */
export async function handleScheduled(
  _controller: ScheduledController,
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM rate_limits WHERE expires_at < ?1').bind(now),
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?1').bind(now),
  ]);

  // Deliberately across all tenants. Sources that are pending or processing are left alone.
  const { results } = await env.DB.prepare(
    `SELECT id, site_id FROM sources WHERE kind = 'crawl' AND status IN ('ready', 'error')`,
  ).all<{ id: string; site_id: string }>();
  const requeue = env.DB.prepare(
    `UPDATE sources SET status = 'pending', error = NULL, updated_at = ?3
     WHERE id = ?1 AND site_id = ?2 AND status IN ('ready', 'error')`,
  );
  for (const group of batches(results)) {
    // Enqueue first: a source marked 'pending' without a job would never be picked up again.
    await env.INGEST_QUEUE.sendBatch(
      group.map((row) => ({ body: { type: 'crawl' as const, siteId: row.site_id, sourceId: row.id } })),
    );
    await env.DB.batch(group.map((row) => requeue.bind(row.id, row.site_id, now)));
  }
}
