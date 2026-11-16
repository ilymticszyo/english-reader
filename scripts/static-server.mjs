// Tiny static file server used by the e2e/screenshot scripts (serves dist/ at "/" and at an optional sub-path).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

export function serve(dir, { port = 0, prefix = '' } = {}) {
  const server = createServer(async (req, res) => {
    let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (prefix) {
      if (!path.startsWith(prefix)) {
        res.writeHead(404).end('not found');
        return;
      }
      path = path.slice(prefix.length - 1);
    }
    if (path.endsWith('/')) path += 'index.html';
    const file = join(dir, normalize(path));
    if (!file.startsWith(dir)) return res.writeHead(403).end();
    try {
      const buf = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' }).end(buf);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}${prefix || '/'}` })));
}
