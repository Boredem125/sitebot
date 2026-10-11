-- Password reset. id is the SHA-256 hex of the emailed token, like sessions.
CREATE TABLE password_resets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX password_resets_user ON password_resets(user_id);

-- 0 on an assistant message the bot could not ground in the site's content.
ALTER TABLE messages ADD COLUMN answered INTEGER NOT NULL DEFAULT 1;
CREATE INDEX messages_unanswered ON messages(site_id, answered, created_at);

ALTER TABLE sites ADD COLUMN suggested_questions TEXT NOT NULL DEFAULT '[]';  -- JSON string[]
ALTER TABLE sites ADD COLUMN lead_capture INTEGER NOT NULL DEFAULT 0;

-- Contact details a visitor left after a question the bot could not answer.
CREATE TABLE leads (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  conversation_id TEXT,
  email TEXT NOT NULL,
  question TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX leads_site ON leads(site_id, created_at);
