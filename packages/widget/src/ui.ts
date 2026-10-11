import { LIMITS } from '@sitebot/shared';
import type { ApiError, ChatRequest, SourceLink, WidgetConfig } from '@sitebot/shared';
import { streamChat } from './api';
import { CSS } from './styles';

const GENERIC_FAILURE = 'Sorry, something went wrong. Please try again.';
const MAX_SOURCES = 3;
const SVG_NS = 'http://www.w3.org/2000/svg';

const ICON_CHAT = 'M4 3h16a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H9l-5 4v-4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z';
const ICON_CLOSE = 'M6 6l12 12M18 6L6 18';
const ICON_SEND = 'M3 20l18-8L3 4v6l11 2-11 2z';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function button(className: string, label: string): HTMLButtonElement {
  const node = el('button', className);
  node.type = 'button';
  node.setAttribute('aria-label', label);
  return node;
}

function icon(d: string, stroked = false): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', d);
  if (stroked) {
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '2');
    path.setAttribute('stroke-linecap', 'round');
  } else {
    path.setAttribute('fill', 'currentColor');
  }
  svg.append(path);
  return svg;
}

/** Black or white, whichever contrasts better with `hex` (#rrggbb), by WCAG relative luminance. */
function textOn(hex: string): string {
  const channel = (at: number): number => {
    const v = parseInt(hex.slice(at, at + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  // 0.179 is the luminance at which black and white give the same contrast ratio.
  return luminance > 0.179 ? '#000' : '#fff';
}

function inSeconds(value: unknown): string {
  const n = Math.ceil(Number(value));
  return n > 0 && Number.isFinite(n) ? `in ${n} second${n === 1 ? '' : 's'}` : 'in a moment';
}

function failureLine(failure: Partial<ApiError>): string {
  if (failure.code === 'rate_limited') {
    return `Too many messages. Please try again ${inSeconds(failure.retryAfter)}.`;
  }
  if (failure.code === 'monthly_cap') return 'This assistant is unavailable right now.';
  return GENERIC_FAILURE;
}

// sessionStorage throws in sandboxed iframes and when storage is blocked; the
// conversation then simply lives in memory for this page view.
function readStored(key: string): string | undefined {
  try {
    return sessionStorage.getItem(key) || undefined;
  } catch {
    return undefined;
  }
}

function writeStored(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // See readStored.
  }
}

function sourceLinks(sources: unknown): HTMLAnchorElement[] {
  const links: HTMLAnchorElement[] = [];
  if (!Array.isArray(sources)) return links;
  for (const source of sources as Partial<SourceLink>[]) {
    if (links.length === MAX_SOURCES) break;
    let url: URL;
    try {
      url = new URL(String(source?.url));
    } catch {
      continue;
    }
    // Model- and crawl-derived URLs: never let javascript:, data: and friends become links.
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
    const title = typeof source.title === 'string' ? source.title.trim() : '';
    const a = el('a', '', title || url.hostname);
    a.href = url.href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer nofollow';
    links.push(a);
  }
  return links;
}

export function mount(config: WidgetConfig, api: string, siteKey: string): void {
  const cidKey = `sitebot:${siteKey}:cid`;
  let conversationId = readStored(cidKey);
  let busy = false;

  const host = el('div');
  host.id = 'sitebot-root';
  const shadow = host.attachShadow({ mode: 'open' });
  try {
    // Constructable sheets are not subject to the host page's style-src CSP.
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS);
    shadow.adoptedStyleSheets = [sheet];
  } catch {
    shadow.append(el('style', '', CSS));
  }

  const wrap = el('div', `w ${config.position === 'left' ? 'l' : 'r'}`);
  wrap.style.setProperty('--c', config.color);
  wrap.style.setProperty('--t', textOn(config.color));

  const launcher = button('b', 'Chat');
  launcher.setAttribute('aria-expanded', 'false');
  launcher.setAttribute('aria-controls', 'p');
  launcher.append(icon(ICON_CHAT), icon(ICON_CLOSE, true));

  const panel = el('div', 'p');
  panel.id = 'p';
  panel.hidden = true;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', `${config.name} chat`);

  const header = el('div', 'h');
  const close = button('x', 'Close chat');
  close.append(icon(ICON_CLOSE, true));
  header.append(el('div', 'n', config.name), close);

  const list = el('div', 'm');
  list.setAttribute('role', 'log');
  list.setAttribute('aria-live', 'polite');

  const footer = el('div', 'f');
  const input = el('textarea');
  input.rows = 1;
  input.maxLength = LIMITS.messageMaxChars;
  input.placeholder = 'Ask a question...';
  input.setAttribute('aria-label', 'Message');
  const sendButton = button('k', 'Send message');
  sendButton.append(icon(ICON_SEND));
  footer.append(input, sendButton);

  panel.append(header, list, footer, el('div', 'q', 'AI answers may be inaccurate'));
  wrap.append(launcher, panel);
  shadow.append(wrap);

  const scrollToEnd = (): void => {
    list.scrollTop = list.scrollHeight;
  };

  /** Runs `change`, then follows the new content only if the reader had not scrolled up. */
  const keepPinned = (change: () => void): void => {
    const pinned = list.scrollHeight - list.scrollTop - list.clientHeight < 48;
    change();
    if (pinned) scrollToEnd();
  };

  const addMessage = (role: 'u' | 'a', text: string) => {
    const group = el('div', `g ${role}`);
    const bubble = el('div', 't');
    // Answers are rendered as plain text only; a Text node can never become markup.
    const textNode = document.createTextNode(text);
    bubble.append(textNode);
    group.append(bubble);
    list.append(group);
    return { group, bubble, textNode };
  };

  const fitInput = (): void => {
    input.style.height = 'auto';
    input.style.height = `${input.scrollHeight + 2}px`;
  };

  const setOpen = (open: boolean): void => {
    panel.hidden = !open;
    wrap.classList.toggle('o', open);
    launcher.setAttribute('aria-expanded', String(open));
    if (open) {
      scrollToEnd();
      input.focus();
    } else {
      launcher.focus();
    }
  };

  const send = async (): Promise<void> => {
    const message = input.value.trim().slice(0, LIMITS.messageMaxChars);
    if (busy || !message) return;
    busy = true;
    input.disabled = sendButton.disabled = true;
    // Hold screen-reader announcements until the reply is complete, not per token.
    list.setAttribute('aria-busy', 'true');
    input.value = '';
    fitInput();

    addMessage('u', message);
    const reply = addMessage('a', '');
    const typing = el('span', 'd');
    typing.setAttribute('role', 'img');
    typing.setAttribute('aria-label', 'Assistant is typing');
    typing.append(el('i'), el('i'), el('i'));
    reply.bubble.append(typing);
    scrollToEnd();

    // Status lines never overwrite text that has already streamed in.
    const say = (line: string): void => {
      typing.remove();
      keepPinned(() => {
        if (reply.textNode.data) addMessage('a', line);
        else reply.textNode.data = line;
      });
    };

    let finished = false;
    try {
      const request: ChatRequest = { siteKey, message };
      if (conversationId) request.conversationId = conversationId;

      const failure = await streamChat(api, request, (event) => {
        switch (event.type) {
          case 'meta':
            if (typeof event.conversationId === 'string' && event.conversationId) {
              conversationId = event.conversationId;
              writeStored(cidKey, conversationId);
            }
            break;
          case 'delta':
            if (typeof event.text === 'string' && event.text) {
              typing.remove();
              keepPinned(() => reply.textNode.appendData(event.text));
            }
            break;
          case 'done': {
            finished = true;
            if (!reply.textNode.data) {
              say(GENERIC_FAILURE);
              break;
            }
            const links = sourceLinks(event.sources);
            if (links.length) {
              const sources = el('div', 's');
              sources.append(...links);
              keepPinned(() => reply.group.append(sources));
            }
            break;
          }
          case 'busy':
            finished = true;
            say(
              `I'm getting a lot of questions right now. Please try again ${inSeconds(event.retryAfter)}.`,
            );
            break;
          case 'error':
            finished = true;
            say(typeof event.message === 'string' && event.message ? event.message : GENERIC_FAILURE);
            break;
        }
      });

      if (failure) say(failureLine(failure));
      else if (!finished) say(GENERIC_FAILURE);
    } catch {
      say(GENERIC_FAILURE);
    } finally {
      typing.remove();
      busy = false;
      input.disabled = sendButton.disabled = false;
      list.removeAttribute('aria-busy');
      if (!panel.hidden) input.focus();
    }
  };

  launcher.addEventListener('click', () => setOpen(panel.hidden));
  close.addEventListener('click', () => setOpen(false));
  sendButton.addEventListener('click', () => void send());
  input.addEventListener('input', fitInput);
  input.addEventListener('keydown', (event) => {
    // isComposing: Enter that confirms an IME candidate must not send the message.
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void send();
    }
  });
  wrap.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !panel.hidden) setOpen(false);
  });
  // Shadow DOM retargets events to the host element, so the page's own keyboard
  // shortcuts cannot tell the visitor is typing in a text field. Keep keys in here.
  for (const type of ['keydown', 'keyup', 'keypress']) {
    wrap.addEventListener(type, (event) => event.stopPropagation());
  }

  if (config.greeting) addMessage('a', config.greeting);
  document.body.append(host);
}
