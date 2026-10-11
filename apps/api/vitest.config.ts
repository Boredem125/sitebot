import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Tests run inside workerd with local D1 and R2. Workers AI, Vectorize, and Queues
// have no local simulator, so tests pass fakes from test/helpers.ts instead.
export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, 'migrations'));
  return {
    plugins: [
      cloudflareTest({
        miniflare: {
          compatibilityDate: '2026-10-01',
          compatibilityFlags: ['nodejs_compat'],
          d1Databases: ['DB'],
          r2Buckets: ['UPLOADS'],
          bindings: {
            TEST_MIGRATIONS: migrations,
            GROQ_API_KEY: 'test-groq-key',
            DEFAULT_MODEL: 'openai/gpt-oss-120b',
            DASHBOARD_ORIGIN: 'http://localhost:5173',
          },
        },
      }),
    ],
    test: {
      setupFiles: ['./test/setup.ts'],
    },
  };
});
