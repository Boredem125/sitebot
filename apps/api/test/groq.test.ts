import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildGroqBody, GroqError, parseSse, streamGroq, type GroqEvent } from '../src/llm/groq';

const encoder = new TextEncoder();

function streamOf(parts: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
}

/** Cuts `bytes` at each offset, so one logical stream arrives as several network reads. */
function splitAt(bytes: Uint8Array, offsets: number[]): Uint8Array[] {
  const parts: Uint8Array[] = [];
  let start = 0;
  for (const offset of [...offsets, bytes.length]) {
    parts.push(bytes.slice(start, offset));
    start = offset;
  }
  return parts;
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of gen) out.push(item);
  return out;
}

const sse = (chunks: unknown[]): string =>
  `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`;

const okResponse = (body: string): Response =>
  new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });

const messages = [
  { role: 'system' as const, content: 'sys' },
  { role: 'user' as const, content: 'hi' },
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseSse', () => {
  it('yields each data payload, including [DONE]', async () => {
    const body = streamOf([encoder.encode('data: {"a":1}\n\ndata: {"b":2}\n\ndata: [DONE]\n\n')]);
    expect(await collect(parseSse(body))).toEqual(['{"a":1}', '{"b":2}', '[DONE]']);
  });

  it('reassembles a payload split in the middle of a line', async () => {
    const bytes = encoder.encode('data: {"text":"hello world"}\n\ndata: [DONE]\n\n');
    const body = streamOf(splitAt(bytes, [3, 9, 20, 31]));
    expect(await collect(parseSse(body))).toEqual(['{"text":"hello world"}', '[DONE]']);
  });

  it('reassembles a multi-byte character split across reads', async () => {
    const payload = '{"text":"café ✓ 日本"}';
    const bytes = encoder.encode(`data: ${payload}\n\n`);
    // 0xE2 starts the three-byte check mark: cut after its first and second byte.
    const mark = bytes.indexOf(0xe2);
    expect(mark).toBeGreaterThan(0);
    const body = streamOf(splitAt(bytes, [mark + 1, mark + 2]));
    expect(await collect(parseSse(body))).toEqual([payload]);
  });

  it('handles CRLF line endings, comments, other fields, and blank lines', async () => {
    const text = ': keep-alive\r\nevent: message\r\ndata: {"a":1}\r\n\r\n\r\ndata:{"b":2}\r\n\r\ndata: [DONE]\r\n\r\n';
    const bytes = encoder.encode(text);
    // One cut lands between the \r and the \n of a line ending.
    const cut = text.indexOf('{"a":1}') + '{"a":1}'.length + 1;
    expect(await collect(parseSse(streamOf(splitAt(bytes, [cut]))))).toEqual(['{"a":1}', '{"b":2}', '[DONE]']);
  });

  it('yields a final payload that has no trailing newline', async () => {
    const body = streamOf([encoder.encode('data: {"a":1}\n\ndata: [DONE]')]);
    expect(await collect(parseSse(body))).toEqual(['{"a":1}', '[DONE]']);
  });
});

describe('buildGroqBody', () => {
  it('uses the GPT-OSS streaming parameters', () => {
    expect(buildGroqBody('openai/gpt-oss-120b', messages)).toEqual({
      model: 'openai/gpt-oss-120b',
      messages,
      stream: true,
      stream_options: { include_usage: true },
      reasoning_effort: 'low',
      include_reasoning: false,
      max_completion_tokens: 800,
    });
  });
});

describe('streamGroq', () => {
  it('yields deltas, then one end event with usage from `usage`', async () => {
    const body = sse([
      { choices: [{ delta: { role: 'assistant', content: '' }, finish_reason: null }] },
      { choices: [{ delta: { content: 'Hello' }, finish_reason: null }] },
      { choices: [{ delta: { content: ', world' }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      {
        choices: [],
        usage: { prompt_tokens: 120, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 64 } },
      },
    ]);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse(body));

    const events = await collect(streamGroq('test-key', 'openai/gpt-oss-120b', messages));
    expect(events).toEqual<GroqEvent[]>([
      { type: 'delta', text: 'Hello' },
      { type: 'delta', text: ', world' },
      {
        type: 'end',
        finishReason: 'stop',
        usage: { promptTokens: 120, completionTokens: 30, cachedTokens: 64 },
      },
    ]);
  });

  it('reads usage from `x_groq.usage` when the chunk has no top-level usage', async () => {
    const body = sse([
      { choices: [{ delta: { content: 'Hi' }, finish_reason: null }] },
      {
        choices: [{ delta: {}, finish_reason: 'length' }],
        x_groq: { usage: { prompt_tokens: 50, completion_tokens: 800 } },
      },
    ]);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse(body));

    const events = await collect(streamGroq('test-key', 'm', messages));
    expect(events.at(-1)).toEqual({
      type: 'end',
      finishReason: 'length',
      usage: { promptTokens: 50, completionTokens: 800, cachedTokens: 0 },
    });
  });

  it('reports zero usage when Groq sent none, and skips malformed lines', async () => {
    const body =
      'data: {"choices":[{"delta":{"content":"A"}}]}\n\n' +
      'data: {not json\n\n' +
      'data: null\n\n' +
      'data: {"choices":[{"delta":{"content":"B"},"finish_reason":"stop"}]}\n\n' +
      'data: [DONE]\n\n' +
      'data: {"choices":[{"delta":{"content":"after done"}}]}\n\n';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse(body));

    const events = await collect(streamGroq('test-key', 'm', messages));
    expect(events).toEqual<GroqEvent[]>([
      { type: 'delta', text: 'A' },
      { type: 'delta', text: 'B' },
      { type: 'end', finishReason: 'stop', usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0 } },
    ]);
  });

  it('sends the documented request and nothing Groq rejects', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse(sse([])));
    const controller = new AbortController();

    await collect(streamGroq('test-key', 'openai/gpt-oss-120b', messages, controller.signal));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(init.method).toBe('POST');
    expect(init.signal).toBe(controller.signal);
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBe('Bearer test-key');
    expect(headers.get('content-type')).toBe('application/json');

    const sent = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(sent.model).toBe('openai/gpt-oss-120b');
    expect(sent.messages).toEqual(messages);
    expect(sent.stream).toBe(true);
    expect(sent.stream_options).toEqual({ include_usage: true });
    expect(sent.reasoning_effort).toBe('low');
    expect(sent.include_reasoning).toBe(false);
    expect(sent.max_completion_tokens).toBe(800);
    expect(sent).not.toHaveProperty('reasoning_format');
    expect(sent).not.toHaveProperty('max_tokens');
    expect(init.body as string).not.toContain('test-key');
  });

  async function failure(response: Response): Promise<GroqError> {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
    try {
      await collect(streamGroq('test-key', 'm', messages));
    } catch (err) {
      expect(err).toBeInstanceOf(GroqError);
      return err as GroqError;
    }
    throw new Error('streamGroq did not throw');
  }

  it('throws GroqError with retryAfter on 429', async () => {
    const err = await failure(new Response('{"error":"slow down"}', { status: 429, headers: { 'retry-after': '7' } }));
    expect(err.status).toBe(429);
    expect(err.retryAfter).toBe(7);
  });

  it('rounds a fractional retry-after up', async () => {
    const err = await failure(new Response('', { status: 429, headers: { 'retry-after': '1.5' } }));
    expect(err.retryAfter).toBe(2);
  });

  it('uses null when retry-after is missing or not a number', async () => {
    expect((await failure(new Response('', { status: 429 }))).retryAfter).toBeNull();
    vi.restoreAllMocks();
    const dated = new Response('', { status: 429, headers: { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' } });
    expect((await failure(dated)).retryAfter).toBeNull();
  });

  it('throws GroqError on 500 without the response body or the key in the message', async () => {
    const err = await failure(new Response('UPSTREAM_SECRET_BODY', { status: 500 }));
    expect(err.status).toBe(500);
    expect(err.retryAfter).toBeNull();
    expect(err.message).not.toContain('UPSTREAM_SECRET_BODY');
    expect(err.message).not.toContain('test-key');
  });
});
