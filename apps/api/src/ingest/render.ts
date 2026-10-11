import type { Env } from '../env';
import { bareHost, isSafeUrl } from './url';

const MAX_HTML_BYTES = 2 * 1024 * 1024;
const NAVIGATION_TIMEOUT_MS = 30_000;

/** Pause between attempts when Browser Run says we are over its rate limit. Tests set it to 0. */
export const renderPacing = { waitMs: 11_000, attempts: 3 };

interface ContentResponse {
  success?: boolean;
  result?: unknown;
  meta?: { status?: number; finalUrl?: string };
}

/**
 * Loads `url` in a real browser (Cloudflare Browser Run) and returns the HTML after the
 * page's JavaScript has run. For sites that draw their content in the browser and whose
 * raw HTML is therefore empty.
 *
 * Returns null whenever a rendered page cannot be had: no binding, rate limit not clearing,
 * an error, an oversized result, or the browser ending up on another site. The caller then
 * keeps the raw HTML it already has.
 */
export async function renderPage(
  env: Pick<Env, 'BROWSER'>,
  url: string,
  site: string,
): Promise<{ html: string; finalUrl: string } | null> {
  if (!env.BROWSER || !isSafeUrl(url)) return null;

  for (let attempt = 1; attempt <= renderPacing.attempts; attempt++) {
    let res: Response;
    try {
      res = await env.BROWSER.quickAction('content', {
        url,
        gotoOptions: { waitUntil: 'networkidle2', timeout: NAVIGATION_TIMEOUT_MS },
        // Text is all we want; skipping these keeps browser time, which is metered, low.
        rejectResourceTypes: ['image', 'media', 'font'],
      });
    } catch {
      return null;
    }
    if (res.status === 429 && attempt < renderPacing.attempts) {
      await res.body?.cancel();
      await scheduler.wait(renderPacing.waitMs);
      continue;
    }
    if (!res.ok) {
      console.error('render failed', { status: res.status });
      await res.body?.cancel();
      return null;
    }

    let body: ContentResponse;
    try {
      body = (await res.json()) as ContentResponse;
    } catch {
      return null;
    }
    const html = body.success === true && typeof body.result === 'string' ? body.result : null;
    if (html === null || html.length > MAX_HTML_BYTES) return null;
    const status = body.meta?.status;
    if (typeof status === 'number' && (status < 200 || status > 299)) return null;

    // The browser follows redirects on its own, including ones made by script, so where it
    // ended up has to pass the same checks as any URL we fetch ourselves.
    const finalUrl = typeof body.meta?.finalUrl === 'string' ? body.meta.finalUrl : url;
    if (!isSafeUrl(finalUrl) || bareHost(finalUrl) !== site) return null;
    return { html, finalUrl };
  }
  return null;
}
