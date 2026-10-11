// Account and content management routes (dashboard, session cookie unless noted).
//
// POST   /api/auth/reset/request             ResetRequest   -> { ok: true }   (no session; always ok, so emails cannot be probed)
// POST   /api/auth/reset/confirm             ResetConfirm   -> { ok: true }   (no session)
// DELETE /api/sites/:id                                     -> { ok: true }   (removes the site and everything indexed for it)
// DELETE /api/sites/:id/sources/:sid                        -> { ok: true }   (removes the source and its indexed content)
// POST   /api/sites/:id/sources/:sid/recrawl                -> { source: Source }   (crawl sources only)

export interface ResetRequest {
  email: string;
}

export interface ResetConfirm {
  /** The token from the emailed link. */
  token: string;
  password: string;
}
