-- All timestamps are Unix epoch milliseconds.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- id is the SHA-256 hex of the session token; the raw token lives only in the cookie.
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE sites (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  public_key TEXT NOT NULL UNIQUE,
  domains TEXT NOT NULL DEFAULT '[]',            -- JSON array of hostnames
  greeting TEXT NOT NULL DEFAULT 'Hi! Ask me anything about this site.',
  color TEXT NOT NULL DEFAULT '#2563eb',
  position TEXT NOT NULL DEFAULT 'right',        -- 'left' | 'right'
  instructions TEXT NOT NULL DEFAULT '',
  model TEXT,                                    -- NULL = DEFAULT_MODEL var
  monthly_cap INTEGER NOT NULL DEFAULT 1000,
  created_at INTEGER NOT NULL
);
CREATE INDEX sites_user ON sites(user_id);

CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                            -- 'crawl' | 'upload' | 'qa'
  label TEXT NOT NULL,                           -- start URL | file name | question
  r2_key TEXT,                                   -- upload only
  content TEXT,                                  -- qa only: the answer
  meta TEXT NOT NULL DEFAULT '{}',               -- JSON; crawl stores robots rules and mode here
  status TEXT NOT NULL DEFAULT 'pending',        -- 'pending' | 'processing' | 'ready' | 'error'
  error TEXT,
  pages INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX sources_site ON sources(site_id);

-- Crawl frontier and dedupe set for one crawl source.
CREATE TABLE crawl_pages (
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',        -- 'pending' | 'done' | 'error'
  PRIMARY KEY (source_id, url)
);

-- chunks.id is also the Vectorize vector id (namespace = site_id).
CREATE TABLE chunks (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  url TEXT NOT NULL DEFAULT '',                  -- '' when the chunk has no public page (upload, qa)
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  doc_hash TEXT NOT NULL,                        -- hash of the whole document; unchanged = skip re-embed
  position INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX chunks_site ON chunks(site_id);
CREATE INDEX chunks_source_url ON chunks(source_id, url);

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX conversations_site ON conversations(site_id, updated_at);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  role TEXT NOT NULL,                            -- 'user' | 'assistant'
  content TEXT NOT NULL,
  sources TEXT NOT NULL DEFAULT '[]',            -- JSON SourceLink[]
  created_at INTEGER NOT NULL
);
CREATE INDEX messages_conversation ON messages(conversation_id, created_at);

CREATE TABLE usage_daily (
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  day TEXT NOT NULL,                             -- 'YYYY-MM-DD', UTC
  messages INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (site_id, day)
);

-- Fixed-window counters. bucket = floor(unix_seconds / window_seconds).
CREATE TABLE rate_limits (
  key TEXT NOT NULL,
  bucket INTEGER NOT NULL,
  count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (key, bucket)
);
