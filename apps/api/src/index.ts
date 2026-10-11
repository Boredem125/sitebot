import { Hono } from 'hono';
import { api } from './api';
import { publicApi } from './chat';
import type { Env, IngestJob } from './env';
import { handleQueue, handleScheduled } from './queue';

const app = new Hono<{ Bindings: Env }>();

app.route('/api', api);
app.route('/v1', publicApi);
app.get('/', (c) => c.text('sitebot api'));

export default {
  fetch: app.fetch,
  queue: handleQueue,
  scheduled: handleScheduled,
} satisfies ExportedHandler<Env, IngestJob>;
