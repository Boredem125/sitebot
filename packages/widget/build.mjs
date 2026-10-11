import { build } from 'esbuild';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';

const GZIP_BUDGET_BYTES = 15 * 1024;

const root = import.meta.dirname;
const outfile = join(root, 'dist', 'widget.js');
// Git-ignored copy: the dashboard's Pages deploy is what serves /widget.js.
const publicCopy = join(root, '..', '..', 'apps', 'dashboard', 'public', 'widget.js');

await build({
  entryPoints: [join(root, 'src', 'index.ts')],
  outfile,
  bundle: true,
  minify: true,
  format: 'iife',
  target: 'es2020',
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'warning',
});

await mkdir(dirname(publicCopy), { recursive: true });
await copyFile(outfile, publicCopy);

const code = await readFile(outfile);
const gzip = gzipSync(code, { level: 9 }).length;
const kb = (bytes) => `${(bytes / 1024).toFixed(2)} KB`;
console.log(`widget.js  raw ${kb(code.length)}  gzip ${kb(gzip)}  (budget ${kb(GZIP_BUDGET_BYTES)})`);

if (gzip > GZIP_BUDGET_BYTES) {
  console.error(`widget.js is over the gzip budget by ${gzip - GZIP_BUDGET_BYTES} bytes`);
  process.exit(1);
}
