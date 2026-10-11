import type { ChatEvent } from '@sitebot/shared';

export interface SseParser {
  /** Feed decoded text exactly as it arrives; an event may span several calls. */
  push(chunk: string): void;
  /** Call once the stream closes, to flush an event that lacks its trailing blank line. */
  end(): void;
}

export function createSseParser(onEvent: (event: ChatEvent) => void): SseParser {
  let buffer = '';
  let data: string[] = [];

  const dispatch = (): void => {
    if (data.length === 0) return;
    const json = data.join('\n');
    data = [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      return;
    }
    if (parsed && typeof (parsed as { type?: unknown }).type === 'string') {
      onEvent(parsed as ChatEvent);
    }
  };

  const line = (raw: string): void => {
    const text = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (text === '') {
      dispatch();
    } else if (text.startsWith('data:')) {
      data.push(text.slice(text.charAt(5) === ' ' ? 6 : 5));
    }
    // Anything else (comments, `event:`, `id:`, `retry:`) is not part of our protocol.
  };

  return {
    push(chunk) {
      buffer += chunk;
      let start = 0;
      for (let nl = buffer.indexOf('\n'); nl !== -1; nl = buffer.indexOf('\n', start)) {
        line(buffer.slice(start, nl));
        start = nl + 1;
      }
      buffer = buffer.slice(start);
    },
    end() {
      if (buffer) line(buffer);
      buffer = '';
      dispatch();
    },
  };
}
