import { env } from 'cloudflare:workers';
import { EMBED_DIMENSIONS, type Env, type IngestJob } from '../src/env';
import { newId } from '../src/util';

/** Deterministic fake embedding: same text gives the same unit-length vector. */
export function fakeVector(text: string): number[] {
  const v = new Array<number>(EMBED_DIMENSIONS).fill(0);
  for (let i = 0; i < text.length; i++) {
    const slot = (text.charCodeAt(i) * 31 + i) % EMBED_DIMENSIONS;
    v[slot] = (v[slot] ?? 0) + 1;
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

export interface FakeAi {
  calls: { model: string; input: unknown }[];
  run(model: string, input: unknown): Promise<unknown>;
  toMarkdown(files: { name: string; blob: Blob }[]): Promise<{ name: string; data: string }[]>;
}

export function fakeAi(): FakeAi {
  const calls: FakeAi['calls'] = [];
  return {
    calls,
    async run(model, input) {
      calls.push({ model, input });
      const text = (input as { text: string[] }).text;
      return { shape: [text.length, EMBED_DIMENSIONS], data: text.map(fakeVector) };
    },
    async toMarkdown(files) {
      return Promise.all(
        files.map(async (f) => ({
          name: f.name,
          mimeType: f.blob.type,
          format: 'markdown',
          tokens: 0,
          data: await f.blob.text(),
        })),
      );
    },
  };
}

interface StoredVector {
  id: string;
  values: number[];
  namespace?: string;
}

export interface FakeVectorize {
  vectors: Map<string, StoredVector>;
  upsert(vectors: StoredVector[]): Promise<{ mutationId: string }>;
  deleteByIds(ids: string[]): Promise<{ mutationId: string }>;
  query(
    vector: number[],
    options?: { topK?: number; namespace?: string },
  ): Promise<{ count: number; matches: { id: string; score: number }[] }>;
}

/** In-memory Vectorize: cosine similarity, namespace filtering, same method shapes we use. */
export function fakeVectorize(): FakeVectorize {
  const vectors = new Map<string, StoredVector>();
  return {
    vectors,
    async upsert(items) {
      for (const item of items) vectors.set(item.id, item);
      return { mutationId: 'test' };
    },
    async deleteByIds(ids) {
      for (const id of ids) vectors.delete(id);
      return { mutationId: 'test' };
    },
    async query(vector, options = {}) {
      const matches = [...vectors.values()]
        .filter((v) => v.namespace === options.namespace)
        .map((v) => ({ id: v.id, score: v.values.reduce((s, x, i) => s + x * (vector[i] ?? 0), 0) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, options.topK ?? 5);
      return { count: matches.length, matches };
    },
  };
}

export interface FakeQueue {
  sent: IngestJob[];
  send(job: IngestJob): Promise<void>;
  sendBatch(messages: Iterable<{ body: IngestJob }>): Promise<void>;
}

export function fakeQueue(): FakeQueue {
  const sent: IngestJob[] = [];
  return {
    sent,
    async send(job) {
      sent.push(job);
    },
    async sendBatch(messages) {
      for (const m of messages) sent.push(m.body);
    },
  };
}

export interface TestEnv {
  env: Env;
  ai: FakeAi;
  vectorize: FakeVectorize;
  queue: FakeQueue;
}

/** Real local D1 and R2 from miniflare, plus fakes for AI, Vectorize, and the ingest queue. */
export function makeEnv(overrides: Partial<Env> = {}): TestEnv {
  const ai = fakeAi();
  const vectorize = fakeVectorize();
  const queue = fakeQueue();
  return {
    ai,
    vectorize,
    queue,
    env: {
      ...env,
      AI: ai as unknown as Ai,
      VECTORIZE: vectorize as unknown as Vectorize,
      INGEST_QUEUE: queue as unknown as Queue<IngestJob>,
      ...overrides,
    },
  };
}

/** Inserts a user and one site. Returns their ids and the site's public key. */
export async function seedSite(
  db: D1Database,
  site: { domains?: string[]; monthlyCap?: number; instructions?: string } = {},
): Promise<{ userId: string; siteId: string; publicKey: string }> {
  const userId = newId();
  const siteId = newId();
  const publicKey = `pk_${newId().replaceAll('-', '')}`;
  const now = Date.now();
  await db.batch([
    db
      .prepare('INSERT INTO users (id, email, password_hash, created_at) VALUES (?1, ?2, ?3, ?4)')
      .bind(userId, `${userId}@example.com`, 'x', now),
    db
      .prepare(
        `INSERT INTO sites (id, user_id, name, public_key, domains, monthly_cap, instructions, created_at)
         VALUES (?1, ?2, 'Test Site', ?3, ?4, ?5, ?6, ?7)`,
      )
      .bind(
        siteId,
        userId,
        publicKey,
        JSON.stringify(site.domains ?? ['example.com']),
        site.monthlyCap ?? 1000,
        site.instructions ?? '',
        now,
      ),
  ]);
  return { userId, siteId, publicKey };
}
