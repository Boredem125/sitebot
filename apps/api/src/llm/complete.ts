import { groqKeys } from './groq';
import type { Env } from '../env';
import type { GroqMessage } from './groq';

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
// Background work only: a stuck call must not hold an ingest job open.
const TIMEOUT_MS = 20_000;

interface Completion {
  choices?: { message?: { content?: string | null } | null }[];
}

/**
 * One non-streaming completion, for background jobs. Visitor answers go through
 * `streamAnswer` in groq.ts. On a non-2xx response it throws an Error that carries
 * the HTTP status as `status` and nothing else: no response body, no key.
 */
export async function completeText(
  env: Pick<Env, 'GROQ_API_KEY'>,
  model: string,
  messages: GroqMessage[],
  maxTokens: number,
): Promise<string> {
  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${groqKeys(env)[0] ?? ''}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
      // `reasoning_format` is deliberately absent: Groq rejects it for GPT-OSS models.
      reasoning_effort: 'low',
      include_reasoning: false,
      max_completion_tokens: maxTokens,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    // The error body is dropped unread so it cannot end up in a log.
    await res.body?.cancel().catch(() => {});
    throw Object.assign(new Error(`Groq request failed with status ${res.status}`), { status: res.status });
  }
  const data = (await res.json()) as Completion | null;
  const content = data?.choices?.[0]?.message?.content;
  return typeof content === 'string' ? content : '';
}
