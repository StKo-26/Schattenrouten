// Tiny static file server for the browser tests. Serves the project root over
// http://localhost:<port> (a secure origin for geolocation/sensor APIs).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon',
};

export function startServer(port = 0) {
  return new Promise((resolve) => {
    const srv = createServer(async (req, res) => {
      try {
        let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
        if (path === '/') path = '/index.html';
        const full = join(ROOT, normalize(path).replace(/^(\.\.[/\\])+/, ''));
        if (!full.startsWith(ROOT)) { res.writeHead(403).end('Forbidden'); return; }
        const data = await readFile(full);
        res.writeHead(200, { 'Content-Type': MIME[extname(full)] || 'application/octet-stream' });
        res.end(data);
      } catch { res.writeHead(404).end('Not found'); }
    });
    srv.listen(port, '127.0.0.1', () => {
      const p = srv.address().port;
      resolve({ url: `http://localhost:${p}`, port: p, close: () => new Promise(r => srv.close(r)) });
    });
  });
}
