import { Hono } from 'hono';
import type { AppEnv } from './auth';

/** Unanswered questions and leads for the dashboard. Mounted under /api after the session check. */
export const insights = new Hono<AppEnv>();
