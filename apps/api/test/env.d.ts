import type { D1Migration } from '@cloudflare/vitest-plugin';
import type { Env as AppEnv } from '../src/env';

declare global {
  namespace Cloudflare {
    // Bindings miniflare provides in tests (see vitest.config.ts). AI, VECTORIZE and
    // INGEST_QUEUE are typed here but absent at runtime: use makeEnv() from helpers.ts.
    interface Env extends AppEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
