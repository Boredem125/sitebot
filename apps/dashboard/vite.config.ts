import { defineConfig } from 'vite';

const API = 'http://localhost:8787';

export default defineConfig({
  // No @vitejs/plugin-react: Vite compiles TSX itself. Spelled out so the build
  // does not depend on tsconfig discovery.
  oxc: { jsx: { runtime: 'automatic', importSource: 'react' } },
  server: {
    port: 5173,
    strictPort: true,
    // Same origin as the API in dev, so the session cookie is first-party
    // exactly as it is behind the Pages Functions in production.
    proxy: {
      '/api': API,
      '/v1': API,
    },
  },
  build: {
    target: 'es2022',
  },
});
