# Sitebot

Embeddable AI answer bot for any website. A site owner signs up, enters their URL, and pastes one `<script>` tag. The bot answers visitor questions from that site's own content.

Stack: Cloudflare Workers (Hono), D1, Vectorize, R2, Queues, Workers AI embeddings (`@cf/baai/bge-m3`), Groq for answers (`openai/gpt-oss-120b`). Design and decisions are in [PLAN.md](PLAN.md).

## Layout

| Path | What |
|---|---|
| `apps/api` | API Worker: chat, ingest queue consumer, dashboard API, D1 migrations |
| `apps/dashboard` | Owner dashboard (React + Vite, Cloudflare Pages). Also serves `widget.js` and proxies `/api` and `/v1` to the Worker |
| `packages/widget` | The embeddable widget, built to one `widget.js` |
| `packages/shared` | Types shared by all three |
| `demo` | Static test page with the script tag |

## Local development

Needs Node 22+, a Cloudflare account, and a Groq API key. Vectorize and Workers AI have no local simulator, so `wrangler dev` talks to the real ones: do the "One-time Cloudflare setup" below first.

```bash
npm install
```

```bash
cp apps/api/.dev.vars.example apps/api/.dev.vars
```

Put your Groq key in `apps/api/.dev.vars` as `GROQ_API_KEY=...`. That file is git-ignored.

```bash
npm run migrate:local -w @sitebot/api
```

Then, each in its own terminal:

```bash
npm run dev:api
```

```bash
npm run dev:dashboard
```

```bash
npm run build -w @sitebot/widget && npm run demo
```

- Dashboard: http://localhost:5173
- Demo page: http://localhost:4000. Put your site's public key in `demo/index.html` and add `localhost` to the site's allowed domains in the dashboard.

## Tests

```bash
npm test
```

API tests run inside the Workers runtime with a local D1. Workers AI, Vectorize, and Queues are faked in tests; Groq is mocked. No account or key is needed.

## One-time Cloudflare setup

Run from `apps/api`:

```bash
npx wrangler login
```

```bash
npx wrangler d1 create sitebot
```

Copy the printed `database_id` into `apps/api/wrangler.jsonc`.

```bash
npx wrangler vectorize create sitebot-chunks --dimensions=1024 --metric=cosine
```

```bash
npx wrangler r2 bucket create sitebot-uploads
```

```bash
npx wrangler queues create sitebot-ingest
```

## Deploy

From `apps/api`:

```bash
npx wrangler d1 migrations apply sitebot --remote
```

```bash
npx wrangler secret put GROQ_API_KEY
```

```bash
npx wrangler deploy
```

From the repo root, build the widget and dashboard, then from `apps/dashboard` deploy to Pages:

```bash
npm run build
```

```bash
npx wrangler pages deploy
```

Finally set `DASHBOARD_ORIGIN` in `apps/api/wrangler.jsonc` to the Pages URL and run `npx wrangler deploy` in `apps/api` again. The dashboard's Pages Functions reach the Worker through a service binding named `API`.

## Limits to know about

- Groq's base rate limits for `openai/gpt-oss-120b` (30 requests/min, 8,000 tokens/min, 200,000 tokens/day per organization) cap the whole service at roughly 60 to 70 answers a day until the limits are raised on the Groq account. When Groq returns 429 the widget tells the visitor to retry shortly.
- The crawler reads server-rendered HTML only (no JavaScript rendering) and stops at 200 pages per site.
- The widget's site key is public and `Origin` can be forged outside a browser. Per-IP and per-site rate limits and the monthly message cap are the real abuse controls.
