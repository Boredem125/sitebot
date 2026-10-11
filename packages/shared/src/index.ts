// Types shared by the API Worker, the dashboard, and the widget.
// Types are erased at build time; `LIMITS` is the only runtime export.

// ---------- Public widget API (/v1) ----------

/** GET /v1/widget/config?site=pk_... */
export interface WidgetConfig {
  name: string;
  greeting: string;
  /** Accent colour, `#rrggbb`. */
  color: string;
  position: 'left' | 'right';
  /** Panel background, `#rrggbb`. Absent = white. */
  background?: string;
  /** Text colour on the panel background, `#rrggbb`. Absent = chosen for contrast. */
  textColor?: string;
  /** One font family name, e.g. `Inter`. Used only if the host page already loads it. */
  font?: string;
  /** Square logo shown on the launcher and in the header. Absent = chat icon. */
  logoUrl?: string;
}

/** POST /v1/chat request body (JSON). */
export interface ChatRequest {
  siteKey: string;
  message: string;
  conversationId?: string;
}

export interface SourceLink {
  url: string;
  title: string;
}

/**
 * POST /v1/chat responds 200 with `text/event-stream`. Each event is one line
 * `data: <JSON ChatEvent>` followed by a blank line. Order: `meta`, then zero or
 * more `delta`, then exactly one of `done` | `busy` | `error`.
 * Failures before the stream starts are JSON `ApiError` with a 4xx status.
 */
export type ChatEvent =
  | { type: 'meta'; conversationId: string }
  | { type: 'delta'; text: string }
  | { type: 'done'; sources: SourceLink[] }
  | { type: 'busy'; retryAfter: number }
  | { type: 'error'; message: string };

export type ApiErrorCode =
  | 'invalid'
  | 'unauthorized'
  | 'forbidden_origin'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'monthly_cap';

/** JSON body of every non-2xx response from /v1 and /api. */
export interface ApiError {
  error: string;
  code: ApiErrorCode;
  /** Seconds. Present on 429 `rate_limited`. */
  retryAfter?: number;
}

// ---------- Dashboard API (/api, session cookie) ----------
// Every timestamp (`createdAt`, `updatedAt`) is Unix epoch milliseconds.
//
// POST   /api/auth/signup                  AuthRequest            -> { user: User }
// POST   /api/auth/login                   AuthRequest            -> { user: User }
// POST   /api/auth/logout                                         -> { ok: true }
// GET    /api/auth/me                                             -> { user: User }   (401 if signed out)
// GET    /api/sites                                               -> { sites: Site[] }
// POST   /api/sites                        CreateSiteRequest      -> { site: Site }   (also starts a crawl of `url`)
// GET    /api/sites/:id                                           -> { site: Site; usage: SiteUsage }
// PATCH  /api/sites/:id                    UpdateSiteRequest      -> { site: Site }
// POST   /api/sites/:id/brand                                     -> { site: Site }   (re-reads colours, font, logo from the site)
// GET    /api/sites/:id/sources                                   -> { sources: Source[] }
// POST   /api/sites/:id/sources/crawl      CrawlRequest           -> { source: Source }
// POST   /api/sites/:id/sources/upload     multipart, field `file`-> { source: Source }
// POST   /api/sites/:id/sources/qa         QaRequest              -> { source: Source }
// GET    /api/sites/:id/conversations                             -> { conversations: ConversationSummary[] }
// GET    /api/sites/:id/conversations/:cid                        -> { messages: Message[] }

export interface User {
  id: string;
  email: string;
}

export interface AuthRequest {
  email: string;
  password: string;
}

export interface Site {
  id: string;
  name: string;
  publicKey: string;
  /** Hostnames allowed to embed the widget, e.g. `example.com`. Subdomains are allowed too. */
  domains: string[];
  greeting: string;
  color: string;
  position: 'left' | 'right';
  /** Brand look. Null = widget default. Filled in from the site on the first crawl. */
  background: string | null;
  textColor: string | null;
  font: string | null;
  logoUrl: string | null;
  /** Extra instructions the owner adds to the bot's system prompt. */
  instructions: string;
  monthlyCap: number;
  createdAt: number;
}

export interface SiteUsage {
  /** `YYYY-MM`, UTC. */
  month: string;
  messages: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  cap: number;
}

export interface CreateSiteRequest {
  name: string;
  url: string;
}

export type UpdateSiteRequest = Partial<
  Pick<
    Site,
    | 'name'
    | 'domains'
    | 'greeting'
    | 'color'
    | 'position'
    | 'instructions'
    | 'background'
    | 'textColor'
    | 'font'
    | 'logoUrl'
  >
>;

export type SourceKind = 'crawl' | 'upload' | 'qa';
export type SourceStatus = 'pending' | 'processing' | 'ready' | 'error';

export interface Source {
  id: string;
  siteId: string;
  kind: SourceKind;
  /** Start URL for `crawl`, file name for `upload`, the question for `qa`. */
  label: string;
  status: SourceStatus;
  error: string | null;
  /** Pages (crawl) or documents (upload, qa) indexed so far. */
  pages: number;
  createdAt: number;
  updatedAt: number;
}

export interface CrawlRequest {
  url: string;
}

export interface QaRequest {
  question: string;
  answer: string;
}

export interface ConversationSummary {
  id: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  /** First visitor message, truncated. */
  preview: string;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  sources: SourceLink[];
  createdAt: number;
}

export const LIMITS = {
  messageMaxChars: 1000,
  uploadMaxBytes: 10 * 1024 * 1024,
  uploadExtensions: ['.pdf', '.txt', '.md'],
  crawlMaxPages: 200,
} as const;
