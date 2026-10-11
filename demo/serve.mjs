// Serves the demo page over http://localhost: the API checks the Origin header,
// which a page opened from file:// does not send usefully.
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';

const port = Number(process.env.PORT) || 4000;

// Fixed map from route to file. The request URL only ever selects a key here and
// is never joined into a filesystem path, so there is nothing to traverse.
const routes = {
  '/': {
    file: join(import.meta.dirname, 'index.html'),
    type: 'text/html; charset=utf-8',
  },
  '/widget.js': {
    file: join(import.meta.dirname, '..', 'packages', 'widget', 'dist', 'widget.js'),
    type: 'text/javascript; charset=utf-8',
  },
};

const server = createServer(async (req, res) => {
  const send = (status, type, body) => {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : body);
  };

  const path = (req.url ?? '').split('?')[0];
  const route = Object.hasOwn(routes, path) ? routes[path] : undefined;
  if (!route || (req.method !== 'GET' && req.method !== 'HEAD')) {
    send(404, 'text/plain; charset=utf-8', 'Not found\n');
    return;
  }

  try {
    send(200, route.type, await readFile(route.file));
  } catch {
    send(
      404,
      'text/plain; charset=utf-8',
      'File not built yet. Run: npm run build -w @sitebot/widget\n',
    );
  }
});

server.listen(port, 'localhost', () => {
  console.log(`sitebot demo: http://localhost:${port}`);
});
