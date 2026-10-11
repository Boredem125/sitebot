import { EMBED_MODEL, type Env } from '../env';

const BATCH = 50;

/** Embeds texts with Workers AI. Returns one vector per input, in order. */
export async function embedTexts(env: Pick<Env, 'AI'>, texts: string[]): Promise<number[][]> {
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const res = (await env.AI.run(EMBED_MODEL, { text: texts.slice(i, i + BATCH) })) as {
      data?: number[][];
    };
    if (!res.data) throw new Error('Embedding model returned no vectors');
    vectors.push(...res.data);
  }
  if (vectors.length !== texts.length) throw new Error('Embedding count mismatch');
  return vectors;
}
