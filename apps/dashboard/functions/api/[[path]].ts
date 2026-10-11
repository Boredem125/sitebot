import type { Fetcher, PagesFunction } from '@cloudflare/workers-types';

// Forward the request untouched: cookies, method, body, and the visitor's
// cf-connecting-ip all reach the API Worker as they arrived.
export const onRequest: PagesFunction<{ API: Fetcher }> = (ctx) => ctx.env.API.fetch(ctx.request);
