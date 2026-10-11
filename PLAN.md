# Sitebot: embeddable AI answer bot for any website (Groq edition)

## Context

Most websites want an AI chat bot, and adding one is still fiddly. Goal: a hosted service where a site owner signs up, enters their URL (and optionally uploads docs), and pastes one `<script>` tag. The bot then answers visitor questions from that site's own content.

This revises the existing plan at `E:\sitebot\no-lets-make-infratsurcture-refactored-cook.md`. The only change is the LLM provider: **Groq instead of Claude**. Everything else (Cloudflare stack, ingest, widget, dashboard, security model) stands. `E:\sitebot` contains only that plan file, so there is no code to reuse.

Decisions already made:

- **Delivery:** hosted multi-tenant SaaS. We run the backend and pay LLM cost.
- **Knowledge:** auto-crawl the site, plus uploaded docs and Q&A pairs.
- **Stack:** TypeScript on Cloudflare (Workers, D1, Vectorize, R2, Queues, Pages).
- **LLM:** Groq, OpenAI-compatible API, key in `GROQ_API_KEY`.
- **Embeddings:** stay on Workers AI `@cf/baai/bge-m3`. Groq has no embedding models.

## What changes versus the old plan

| Area | Old (Claude) | New (Groq) |
|---|---|---|
| Client | `@anthropic-ai/sdk`, `client.messages.stream` | plain `fetch` to `https://api.groq.com/openai/v1/chat/completions`, no SDK dependency |
| Default model | `claude-opus-5-5` | `openai/gpt-oss-120b` |
| Prompt caching | explicit `cache_control` | automatic on `openai/gpt-oss-*`; keep the system prompt byte-stable and first |
| Effort | `output_config: { effort: "low" }` | `reasoning_effort: "low"`, `include_reasoning: false` |
| Output cap | `max_tokens` | `max_completion_tokens` |
| Stream parsing | `text_delta` events, `finalMessage()` | SSE lines `data: {...}`, read `choices[0].delta.content`, stop at `data: [DONE]` |
| Usage | `usage.input_tokens` / `output_tokens` | `stream_options: { include_usage: true }`, then `usage.prompt_tokens` / `completion_tokens` / `prompt_tokens_details.cached_tokens` on the last chunk |
| Refusals | `stop_reason: "refusal"` plus server-side fallback beta | removed. Only `finish_reason` (`stop`, `length`) is checked |
| Secret | `ANTHROPIC_API_KEY` | `GROQ_API_KEY` |
| Upstream 429 | not covered | read `retry-after`, send the widget a "busy, try again shortly" SSE event |

`reasoning_format` is not sent: Groq rejects it for GPT-OSS models.

## Architecture

```
visitor browser                      site owner
  widget.js (Shadow DOM)               dashboard (React, Pages)
       | POST /v1/chat (SSE)                 | /api/* (session cookie)
       v                                     v
  ------------------ API Worker (Hono) ------------------
   chat: auth -> limits -> embed -> Vectorize -> Groq stream
   ingest: enqueue crawl / upload jobs
       |              |             |            |
      D1          Vectorize         R2         Queues -> ingest consumer
  (tenants, chunks,  (one index,  (uploads)    (crawl, chunk, embed)
   chats, usage)   namespace=site)
```

## Repo layout (npm workspaces)

- `apps/api/` — Worker: `src/index.ts` (Hono routes), `src/chat.ts`, `src/llm/groq.ts` (request builder and SSE parser), `src/ingest/{crawl,extract,chunk,embed}.ts`, `src/auth.ts`, `src/limits.ts`, `migrations/*.sql`, `wrangler.jsonc`, `.dev.vars.example`
- `apps/dashboard/` — React + Vite, deployed to Pages
- `packages/widget/` — vanilla TS, esbuild to one IIFE `widget.js` (target under 15 KB gzip)
- `packages/shared/` — shared types (API payloads, site config)
- `demo/index.html` — static test page with the script tag

## Components

**Widget.** Install is `<script src="https://<cdn>/widget.js" data-site="pk_..." async></script>`. Renders a floating bubble and chat panel inside a Shadow DOM so host-site CSS cannot break it. Fetches theme and greeting from `GET /v1/widget/config`, streams answers from `POST /v1/chat` using fetch streaming, keeps the conversation ID in `sessionStorage`, shows source links under each answer.

**Ingest.**
- Crawl: read `sitemap.xml`, else same-origin breadth-first link walk. Respect `robots.txt`. Cap 200 pages per site in v1. Extract text with `HTMLRewriter`, dropping nav, script, and style.
- Uploads: PDF, txt, md stored in R2; text extracted with Workers AI `toMarkdown` (fallback `unpdf`). Q&A pairs entered in the dashboard are stored as chunks directly.
- Chunk at roughly 500 tokens with overlap (down from 800, see rate limits below); hash content so unchanged pages are skipped on re-crawl.
- Embed with Workers AI `@cf/baai/bge-m3` (multilingual), upsert to Vectorize with `namespace = site_id`.
- Runs as a Queues consumer; a weekly Cron Trigger re-crawls each site.

**Chat request flow.**
1. Look up site by public key; reject if `Origin` is not in the site's domain allowlist.
2. Rate limit per IP and per site; check the site's monthly message cap.
3. Embed the question, query Vectorize (top 5) in the site's namespace, load chunk text from D1.
4. `src/llm/groq.ts` posts to Groq with `stream: true`, `stream_options: { include_usage: true }`, `model` from `sites.model`, `reasoning_effort: "low"`, `include_reasoning: false`, `max_completion_tokens: 400`. Messages: stable system prompt, last few turns of history, then the user turn with retrieved chunks inside `<context>` tags.
5. Parse Groq's SSE, forward `delta.content` to the widget as our own SSE events. On the final chunk read `finish_reason` and `usage`, then save messages and token usage to D1 via `ctx.waitUntil`.
6. Upstream errors: 429 becomes a `busy` event carrying `retry-after`; 401 and 5xx become a generic `error` event and are logged. The key and Groq's raw error body never reach the browser.

**Dashboard.** Sign up and log in (email + password, PBKDF2 via WebCrypto, session rows in D1). Create a site, add crawl URL and uploads, see ingest status, edit greeting, colors, and extra instructions, copy the install snippet, read past conversations, see usage against the cap.

**D1 tables.** `users`, `sessions`, `sites` (public key, domain allowlist, theme, model, monthly cap), `sources`, `chunks`, `conversations`, `messages`, `usage_daily`.

## Model, cost, and rate limits

Default model is `openai/gpt-oss-120b`, stored per site in `sites.model` and overridable by a `DEFAULT_MODEL` variable. Prices from console.groq.com/docs/models, read 2026-10-11. Rough cost per answered message (about 3K input + 300 output tokens):

| Model | Price per 1M (in / out) | Per message | Per 10,000 messages |
|---|---|---|---|
| `openai/gpt-oss-120b` | $0.15 / $0.60 | about $0.0006 | about $6.30 |
| `openai/gpt-oss-20b` | $0.075 / $0.30 | about $0.0003 | about $3.15 |

Both are production models with automatic prompt caching. `llama-3.3-70b-versatile` and `llama-3.1-8b-instant` are also production but have no caching and no public price, so they are not the default.

**Rate limits are the real constraint, not price.** Groq's published base limits for `openai/gpt-oss-120b` are 30 requests/min, 1,000 requests/day, 8,000 tokens/min, 200,000 tokens/day, counted per organization. At about 3K tokens per message that is roughly 2 answers per minute and 60 to 70 per day across all tenants combined. Consequences built into the plan:

- Smaller prompts: top 5 chunks of about 500 tokens instead of top 8 of 800, which brings a message to about 2K tokens.
- The 429 path in step 6 is a first-class case, tested, not an afterthought.
- Several keys from the same Groq organization share one limit, so the Worker takes a single `GROQ_API_KEY`. Real capacity comes from raising the limits on the Groq account before launch.

## Security and abuse

- The public key is visible in page source and `Origin` can be forged outside a browser. Rate limits and the monthly cap are the real protection; Cloudflare Turnstile can be added later.
- Crawled pages and visitor messages are untrusted input. The system prompt restricts answers to the provided context, and v1 gives the model no tools, so an injection can only produce wrong text.
- Crawler validates scheme and host and refuses private or local addresses.
- Tenant isolation: every D1 query filters by `site_id`; Vectorize queries always pass the namespace.
- `GROQ_API_KEY` is a Worker secret, never sent to the browser. Local runs read it from `apps/api/.dev.vars`, which is git-ignored.

## Build order

1. Scaffold in `E:\sitebot`: `git init`, npm workspaces, `wrangler.jsonc`, D1 migrations, `.gitignore`, `.dev.vars.example`.
2. Ingest pipeline (crawl, extract, chunk, embed, upsert) with a trigger endpoint.
3. `src/llm/groq.ts` and the chat endpoint with retrieval and streaming.
4. Widget, plus `demo/index.html`.
5. Dashboard: auth, sites, sources, snippet, conversations.
6. Limits, usage tracking, weekly re-crawl.
7. Deploy Worker and Pages.
8. Update `E:\sitebot\no-lets-make-infratsurcture-refactored-cook.md` to match this plan.

Out of scope for v1: billing, human handoff, JavaScript-rendered pages (Browser Rendering), lead capture, analytics charts, multi-provider fallback.

## What you need to provide

- A Cloudflare account: run `npx wrangler login` yourself when prompted. Node v22.14.0 and npm 10.9.2 are already installed.
- A Groq API key. You put it in `apps/api/.dev.vars` as `GROQ_API_KEY=...` for local runs and run `npx wrangler secret put GROQ_API_KEY` for production. I will not handle the key value.
- Confirm Queues and Vectorize are available on your Cloudflare plan; if Queues is not, ingest falls back to Cloudflare Workflows.

## Verification

- Unit tests with `vitest` and `@cloudflare/vitest-pool-workers`: chunker, HTML extraction, origin allowlist, rate limit, cap check, and the Groq SSE parser (split chunks across network reads, `[DONE]`, final usage chunk, 429 with `retry-after`) against a mocked `fetch`.
- Local run with `wrangler dev` using remote bindings for Vectorize and Workers AI (neither runs locally).
- End to end in the built-in browser: create a site in the dashboard, crawl a small docs site, open `demo/index.html`, ask a question the site answers and confirm a streamed reply with a source link.
- Negative checks: off-topic question returns "I don't know" rather than an invented answer; a request with a wrong `Origin` gets 403; exceeding our rate limit gets 429; a second site cannot retrieve the first site's chunks.
- Check `usage.prompt_tokens_details.cached_tokens` is non-zero on repeat questions to confirm Groq prompt caching works.
- Confirm no reasoning text leaks into answers (`include_reasoning: false` honoured).
