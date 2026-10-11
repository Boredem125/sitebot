import { Hono } from 'hono';
import type { AppEnv } from './auth';

/** Password reset routes. Mounted under /api before the session check: callers are signed out. */
export const resetRoutes = new Hono<AppEnv>();
