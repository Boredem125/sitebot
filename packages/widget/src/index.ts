import { loadConfig } from './api';
import { mount } from './ui';

declare global {
  interface Window {
    __sitebot?: true;
  }
}

// Read synchronously: document.currentScript is null as soon as this script's task ends.
const script = document.currentScript;

function apiBase(tag: HTMLScriptElement): string | null {
  try {
    const override = tag.getAttribute('data-api')?.trim();
    const url = new URL(override || tag.src, location.href);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    // Default: the API lives on the origin that served this script.
    return override ? (url.origin + url.pathname).replace(/\/+$/, '') : url.origin;
  } catch {
    return null;
  }
}

async function start(): Promise<void> {
  // The snippet pasted twice (or added by a tag manager as well) must not create two widgets.
  if (window.__sitebot) return;

  const tag = script instanceof HTMLScriptElement ? script : null;
  const siteKey = tag?.getAttribute('data-site')?.trim();
  if (!tag || !siteKey) {
    console.warn('[sitebot] The widget script tag needs a data-site="pk_..." attribute.');
    return;
  }
  const api = apiBase(tag);
  if (!api) return;
  window.__sitebot = true;

  const config = await loadConfig(api, siteKey);
  if (!config) return;

  // An async script in <head> can run before <body> exists.
  if (!document.body) {
    await new Promise<void>((resolve) => {
      document.addEventListener('DOMContentLoaded', () => resolve(), { once: true });
    });
  }
  mount(config, api, siteKey);
}

// Whatever goes wrong in here must never surface as an error on the host page.
start().catch(() => {});
