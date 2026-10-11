import { INSIGHT_LIMITS } from '@sitebot/shared';
import type { ApiError, ChatEvent, ChatRequest, LeadRequest, WidgetConfig } from '@sitebot/shared';
import { createSseParser } from './sse';

const DEFAULT_COLOR = '#2563eb';

const hex = (value: unknown): string | null =>
  typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : null;

/** Returns null on any failure: a broken widget must stay invisible, not break the host page. */
export async function loadConfig(api: string, siteKey: string): Promise<WidgetConfig | null> {
  try {
    const res = await fetch(`${api}/v1/widget/config?site=${encodeURIComponent(siteKey)}`, {
      credentials: 'omit',
    });
    if (!res.ok) return null;
    const raw: unknown = await res.json();
    if (!raw || typeof raw !== 'object') return null;
    // Site config is owner-supplied, so every field is checked rather than trusted.
    const { name, greeting, color, position, background, textColor, font, logoUrl, suggestedQuestions, leadCapture } =
      raw as Partial<Record<keyof WidgetConfig, unknown>>;
    const config: WidgetConfig = {
      name: (typeof name === 'string' && name.trim()) || 'Chat',
      greeting: typeof greeting === 'string' ? greeting.trim() : '',
      color: hex(color) ?? DEFAULT_COLOR,
      position: position === 'left' ? 'left' : 'right',
    };
    const bg = hex(background);
    const fg = hex(textColor);
    if (bg) config.background = bg;
    if (fg) config.textColor = fg;
    // One plain family name only: it is placed inside quotes in a CSS variable.
    if (typeof font === 'string' && /^[A-Za-z0-9][A-Za-z0-9 _-]{0,59}$/.test(font)) config.font = font;
    if (typeof logoUrl === 'string') {
      try {
        const url = new URL(logoUrl);
        if (url.protocol === 'https:' || url.protocol === 'http:') config.logoUrl = url.href;
      } catch {
        // Not a URL: no logo.
      }
    }
    // Starter questions may be model-written: strings only, short, and never more than three.
    if (Array.isArray(suggestedQuestions)) {
      const questions = suggestedQuestions
        .flatMap((q: unknown) =>
          typeof q === 'string' && q.trim() ? [q.trim().slice(0, INSIGHT_LIMITS.suggestedQuestionMaxChars)] : [],
        )
        .slice(0, INSIGHT_LIMITS.suggestedQuestions);
      if (questions.length) config.suggestedQuestions = questions;
    }
    if (leadCapture === true) config.leadCapture = true;
    return config;
  } catch {
    return null;
  }
}

/**
 * Streams one chat turn. Resolves with null once the stream has ended, or with the
 * (possibly empty) ApiError body when the API refused the request up front.
 * Rejects on network failure.
 */
export async function streamChat(
  api: string,
  request: ChatRequest,
  onEvent: (event: ChatEvent) => void,
): Promise<Partial<ApiError> | null> {
  const res = await fetch(`${api}/v1/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
    credentials: 'omit',
  });

  if (res.status !== 200 || !res.body) {
    try {
      const body: unknown = await res.json();
      if (body && typeof body === 'object') return body as Partial<ApiError>;
    } catch {
      // Not JSON (e.g. a proxy error page): the caller shows the generic line.
    }
    return {};
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let ended = false;
  const parser = createSseParser((event) => {
    if (event.type === 'done' || event.type === 'busy' || event.type === 'error') ended = true;
    onEvent(event);
  });

  // Stop at the terminal event instead of waiting for the socket to close, so the
  // input is usable again even if a proxy holds the connection open.
  while (!ended) {
    const { done, value } = await reader.read();
    if (done) break;
    parser.push(decoder.decode(value, { stream: true }));
  }
  if (ended) {
    reader.cancel().catch(() => {});
  } else {
    parser.push(decoder.decode());
    parser.end();
  }
  return null;
}

/** Sends the visitor's contact details. False on any failure; the form then offers a retry. */
export async function sendLead(api: string, lead: LeadRequest): Promise<boolean> {
  try {
    const res = await fetch(`${api}/v1/lead`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(lead),
      credentials: 'omit',
    });
    return res.ok;
  } catch {
    return false;
  }
}
