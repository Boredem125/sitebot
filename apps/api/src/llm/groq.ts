import type { Env } from '../env';
import type { TokenUsage } from '../limits';

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

// Reasoning tokens count against the cap, so this leaves room for a short answer.
const MAX_COMPLETION_TOKENS = 800;

export interface GroqMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Upstream failure. The message never carries the response body or the API key. */
export class GroqError extends Error {
  status: number;
  /** Seconds, from the `retry-after` header. Null when Groq sent none. */
  retryAfter: number | null;

  constructor(status: number, retryAfter: number | null) {
    super(`Groq request failed with status ${status}`);
    this.name = 'GroqError';
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export type GroqEvent =
  | { type: 'delta'; text: string }
  | { type: 'end'; finishReason: string | null; usage: TokenUsage };

export function buildGroqBody(model: string, messages: GroqMessage[]): Record<string, unknown> {
  return {
    model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    // `reasoning_format` is deliberately absent: Groq rejects it for GPT-OSS models.
    reasoning_effort: 'low',
    include_reasoning: false,
    max_completion_tokens: MAX_COMPLETION_TOKENS,
  };
}

function dataPayload(rawLine: string): string | null {
  const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
  if (!line.startsWith('data:')) return null;
  const payload = line.slice(5);
  return payload.startsWith(' ') ? payload.slice(1) : payload;
}

/** Yields the payload of every `data:` line, including the final `[DONE]`. */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  // stream: true keeps a multi-byte character that straddles two reads intact.
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const payload = dataPayload(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (payload !== null) yield payload;
        newline = buffer.indexOf('\n');
      }
    }
    buffer += decoder.decode();
    const last = dataPayload(buffer);
    if (last !== null) yield last;
  } finally {
    // Frees the connection when the consumer stops early. A no-op once the stream has ended.
    await reader.cancel().catch(() => {});
  }
}

interface GroqUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number } | null;
}

interface GroqChunk {
  choices?: { delta?: { content?: string | null }; finish_reason?: string | null }[];
  usage?: GroqUsage | null;
  x_groq?: { usage?: GroqUsage | null } | null;
}

const count = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

function parseRetryAfter(header: string | null): number | null {
  if (header === null || header.trim() === '') return null;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds) : null;
}

/**
 * Streams an answer for the chat endpoint. This is the one place that decides which key
 * and which model serve a request.
 */
export function streamAnswer(
  env: Pick<Env, 'GROQ_API_KEY' | 'GROQ_API_KEYS' | 'FALLBACK_MODEL'>,
  model: string,
  messages: GroqMessage[],
  signal?: AbortSignal,
): AsyncGenerator<GroqEvent> {
  return streamGroq(env.GROQ_API_KEY, model, messages, signal);
}

/** Streams one chat completion: text deltas, then exactly one `end` event. */
export async function* streamGroq(
  apiKey: string,
  model: string,
  messages: GroqMessage[],
  signal?: AbortSignal,
): AsyncGenerator<GroqEvent> {
  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(buildGroqBody(model, messages)),
    signal,
  });
  if (!res.ok || !res.body) {
    // The error body is dropped unread so it cannot end up in a log or a client response.
    await res.body?.cancel().catch(() => {});
    throw new GroqError(res.status, parseRetryAfter(res.headers.get('retry-after')));
  }

  let finishReason: string | null = null;
  const usage: TokenUsage = { promptTokens: 0, completionTokens: 0, cachedTokens: 0 };

  for await (const payload of parseSse(res.body)) {
    if (payload === '[DONE]') break;
    let chunk: GroqChunk;
    try {
      chunk = JSON.parse(payload) as GroqChunk;
    } catch {
      continue;
    }
    if (chunk === null || typeof chunk !== 'object') continue;

    const choice = chunk.choices?.[0];
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    const text = choice?.delta?.content;
    if (typeof text === 'string' && text !== '') yield { type: 'delta', text };

    const reported = chunk.usage ?? chunk.x_groq?.usage;
    if (reported) {
      usage.promptTokens = count(reported.prompt_tokens);
      usage.completionTokens = count(reported.completion_tokens);
      usage.cachedTokens = count(reported.prompt_tokens_details?.cached_tokens);
    }
  }

  yield { type: 'end', finishReason, usage };
}
