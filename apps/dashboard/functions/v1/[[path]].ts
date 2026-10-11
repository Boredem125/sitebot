import type { Fetcher, PagesFunction } from '@cloudflare/workers-types';

// Same-origin path for the widget's /v1 calls when it is loaded from this host.
export const onRequest: PagesFunction<{ API: Fetcher }> = (ctx) => ctx.env.API.fetch(ctx.request);
