import { INSIGHT_LIMITS, LIMITS } from '@sitebot/shared';
import type { ApiError, ChatRequest, LeadRequest, SourceLink, WidgetConfig } from '@sitebot/shared';
import { sendLead, streamChat } from './api';
import { renderMarkdown } from './md';
import { CSS } from './styles';

const GENERIC_FAILURE = 'Sorry, something went wrong. Please try again.';
const MAX_SOURCES = 3;
const SVG_NS = 'http://www.w3.org/2000/svg';

const ICON_CHAT = 'M4 3h16a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H9l-5 4v-4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z';
const ICON_CLOSE = 'M6 6l12 12M18 6L6 18';
const ICON_SEND = 'M3 20l18-8L3 4v6l11 2-11 2z';
const ICON_MIC =
  'M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11z';

const NOTE = 'AI answers may be inaccurate';

// The browser's speech-to-text. Not in TypeScript's DOM types, so only what we use is declared.
interface Recognition {
  lang: string;
  interimResults: boolean;
  start(): void;
  stop(): void;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
}

function recognitionCtor(): (new () => Recognition) | undefined {
  const w = window as unknown as Record<string, (new () => Recognition) | undefined>;
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

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

/** WCAG relative luminance of `hex` (#rrggbb). */
function luminance(hex: string): number {
  const channel = (at: number): number => {
    const v = parseInt(hex.slice(at, at + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

// 0.179 is the luminance at which black and white give the same contrast ratio.
const isLight = (hex: string): boolean => luminance(hex) > 0.179;

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** The site logo, or null. It removes itself if the image cannot be loaded. */
function logo(url: string | undefined, onFail: () => void): HTMLImageElement | null {
  if (!url) return null;
  const img = el('img');
  img.alt = '';
  img.decoding = 'async';
  img.referrerPolicy = 'no-referrer';
  img.addEventListener('error', () => {
    img.remove();
    onFail();
  });
  img.src = url;
  return img;
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
  // The panel takes the site's own colours and font so it reads as part of the page.
  const background = config.background ?? '#ffffff';
  const text =
    config.textColor && contrast(config.textColor, background) >= 4.5
      ? config.textColor
      : isLight(background)
        ? '#111827'
        : '#f3f4f6';
  wrap.style.setProperty('--c', config.color);
  wrap.style.setProperty('--t', isLight(config.color) ? '#000' : '#fff');
  wrap.style.setProperty('--bg', background);
  wrap.style.setProperty('--fg', text);
  // Links use the accent only where it is readable on the panel.
  wrap.style.setProperty('--lk', contrast(config.color, background) >= 3 ? config.color : text);
  // The family name is validated in loadConfig, so it cannot contain a quote.
  if (config.font) wrap.style.setProperty('--ff', `"${config.font}"`);

  const launcher = button('b', 'Chat');
  launcher.setAttribute('aria-expanded', 'false');
  launcher.setAttribute('aria-controls', 'p');
  const launcherLogo = logo(config.logoUrl, () => launcher.classList.remove('lg'));
  if (launcherLogo) {
    launcher.classList.add('lg');
    launcher.append(launcherLogo);
  }
  launcher.append(icon(ICON_CHAT), icon(ICON_CLOSE, true));

  const panel = el('div', 'p');
  panel.id = 'p';
  panel.hidden = true;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', `${config.name} chat`);

  const header = el('div', 'h');
  const close = button('x', 'Close chat');
  close.append(icon(ICON_CLOSE, true));
  const headerLogo = logo(config.logoUrl, () => {});
  if (headerLogo) header.append(headerLogo);
  header.append(el('div', 'n', config.name), close);

  const list = el('div', 'm');
  list.setAttribute('role', 'log');
  list.setAttribute('aria-live', 'polite');
  // Starter questions, shown under the greeting until the visitor sends something.
  const starters = el('div', 'sq');

  const footer = el('div', 'f');
  const input = el('textarea');
  input.rows = 1;
  input.maxLength = LIMITS.messageMaxChars;
  input.placeholder = 'Ask a question...';
  input.setAttribute('aria-label', 'Message');
  const sendButton = button('k', 'Send message');
  sendButton.append(icon(ICON_SEND));
  // Speak-to-type. Only offered where the browser can do it (not Firefox).
  const mic = recognitionCtor() ? button('v', 'Speak your question') : null;
  if (mic) {
    mic.setAttribute('aria-pressed', 'false');
    mic.append(icon(ICON_MIC));
    footer.append(input, mic, sendButton);
  } else {
    footer.append(input, sendButton);
  }

  const note = el('div', 'q', NOTE);
  panel.append(header, list, footer, note);
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
    // Plain text here; only streamed answers go through the Markdown renderer.
    bubble.textContent = text;
    group.append(bubble);
    list.append(group);
    return { group, bubble };
  };

  const fitInput = (): void => {
    input.style.height = 'auto';
    input.style.height = `${input.scrollHeight + 2}px`;
  };

  let listening: Recognition | null = null;
  const stopListening = (): void => listening?.stop();

  /** Dictation fills the text box as the visitor speaks. Nothing is sent until they press send. */
  const toggleListening = (): void => {
    if (listening) {
      listening.stop();
      return;
    }
    const Ctor = recognitionCtor();
    if (!Ctor || !mic || busy) return;
    const recognition = new Ctor();
    const typed = input.value.trimEnd();
    recognition.lang = document.documentElement.lang || navigator.language || 'en-US';
    recognition.interimResults = true;
    recognition.onresult = (event) => {
      let spoken = '';
      for (let i = 0; i < event.results.length; i++) spoken += event.results[i]?.[0]?.transcript ?? '';
      input.value = `${typed}${typed && spoken ? ' ' : ''}${spoken}`.slice(0, LIMITS.messageMaxChars);
      fitInput();
    };
    recognition.onerror = (event) => {
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        note.textContent = 'Microphone access is blocked for this site.';
      } else if (event.error !== 'aborted' && event.error !== 'no-speech') {
        note.textContent = 'Voice input is not available right now.';
      }
    };
    recognition.onend = () => {
      listening = null;
      mic.classList.remove('on');
      mic.setAttribute('aria-pressed', 'false');
      if (!panel.hidden && !busy) input.focus();
    };
    try {
      recognition.start();
      listening = recognition;
      note.textContent = NOTE;
      mic.classList.add('on');
      mic.setAttribute('aria-pressed', 'true');
    } catch {
      // start() throws if the browser refuses outright; the button simply stays idle.
    }
  };

  // The conversation a contact request was last sent for: one per conversation is enough.
  const leadKey = `sitebot:${siteKey}:lead`;
  let leadSentFor = readStored(leadKey);
  let leadForm: HTMLFormElement | null = null;

  /** Under an answer the bot could not give: offers to pass the question on to the site's team. */
  const offerContact = (group: HTMLElement, question: string): void => {
    if (conversationId && leadSentFor === conversationId) return;
    // Only the latest unanswered question keeps its form.
    leadForm?.remove();
    const form = el('form', 'e');
    form.setAttribute('aria-label', 'Leave your email');
    const email = el('input');
    email.type = 'email';
    email.required = true;
    email.maxLength = INSIGHT_LIMITS.emailMaxChars;
    email.autocomplete = 'email';
    email.placeholder = 'you@example.com';
    email.setAttribute('aria-label', 'Your email');
    const row = el('div', 'er');
    // A plain <button> in a form submits it, so Enter in the field and the button do the same thing.
    const submit = el('button', '', 'Send');
    row.append(email, submit);
    const problem = el('div', 'ee');
    form.append(
      el('div', '', 'Want a reply from the team? Leave your email.'),
      row,
      el('div', 'ec', 'Used only to reply to this question.'),
      problem,
    );

    let sending = false;
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const address = email.value.trim();
      if (sending || !address) return;
      sending = true;
      // aria-disabled rather than disabled: a disabled button would drop the keyboard focus it holds.
      submit.setAttribute('aria-disabled', 'true');
      problem.textContent = '';
      const lead: LeadRequest = { siteKey, email: address, question };
      if (conversationId) lead.conversationId = conversationId;
      void sendLead(api, lead).then((ok) => {
        sending = false;
        submit.removeAttribute('aria-disabled');
        if (!ok) {
          keepPinned(() => {
            problem.textContent = 'That did not go through. Please try again.';
          });
          return;
        }
        leadSentFor = conversationId;
        if (conversationId) writeStored(leadKey, conversationId);
        // The form is about to go. If the keyboard was inside it, the message box is the next stop.
        const hadFocus = form.contains(shadow.activeElement);
        form.replaceWith(el('div', 'e', 'Thanks. We will get back to you.'));
        leadForm = null;
        if (hadFocus && !input.disabled) input.focus();
      });
    });

    leadForm = form;
    // Never focused from here: the visitor's cursor stays in the message box.
    keepPinned(() => group.append(form));
  };

  const setOpen = (open: boolean): void => {
    if (!open) stopListening();
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

  /** Sends what is in the message box, or `preset` when a starter question was picked. */
  const send = async (preset?: string): Promise<void> => {
    const message = (preset ?? input.value).trim().slice(0, LIMITS.messageMaxChars);
    if (busy || !message) return;
    stopListening();
    busy = true;
    input.disabled = sendButton.disabled = true;
    if (mic) mic.disabled = true;
    // Hold screen-reader announcements until the reply is complete, not per token.
    list.setAttribute('aria-busy', 'true');
    // A starter question leaves whatever the visitor was typing where it is.
    if (preset === undefined) {
      input.value = '';
      fitInput();
    }
    starters.remove();

    addMessage('u', message);
    const reply = addMessage('a', '');
    let answer = '';
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
        if (answer) addMessage('a', line);
        else reply.bubble.textContent = line;
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
              answer += event.text;
              keepPinned(() => {
                reply.bubble.classList.add('md');
                renderMarkdown(reply.bubble, answer);
              });
            }
            break;
          case 'done': {
            finished = true;
            if (!answer) {
              say(GENERIC_FAILURE);
              break;
            }
            const links = sourceLinks(event.sources);
            if (links.length) {
              const sources = el('div', 's');
              sources.append(...links);
              keepPinned(() => reply.group.append(sources));
            }
            if (event.offerContact === true) offerContact(reply.group, message);
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
      if (mic) mic.disabled = false;
      list.removeAttribute('aria-busy');
      if (!panel.hidden) input.focus();
    }
  };

  launcher.addEventListener('click', () => setOpen(panel.hidden));
  close.addEventListener('click', () => setOpen(false));
  sendButton.addEventListener('click', () => void send());
  mic?.addEventListener('click', toggleListening);
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
  // Already checked in loadConfig: at most three short strings.
  for (const question of config.suggestedQuestions ?? []) {
    const pill = el('button', '', question);
    pill.type = 'button';
    pill.addEventListener('click', () => void send(question));
    starters.append(pill);
  }
  if (starters.childElementCount) {
    starters.setAttribute('role', 'group');
    starters.setAttribute('aria-label', 'Suggested questions');
    list.append(starters);
  }
  document.body.append(host);
}
