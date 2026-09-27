#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rtapRoot = path.resolve(__dirname, '..');

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '127.0.0.1';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.sarif': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

const server = http.createServer((req, res) => {
  // Enable local CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  let pathname = decodeURIComponent(parsedUrl.pathname);

  // Default to index.html
  if (pathname === '/' || pathname === '') {
    pathname = '/dashboard/index.html';
  } else if (!pathname.startsWith('/dashboard/') && !pathname.startsWith('/m1/') && !pathname.startsWith('/demo/')) {
    // If relative to dashboard root
    if (fs.existsSync(path.join(__dirname, pathname))) {
      pathname = '/dashboard' + pathname;
    }
  }

  // Safe path resolution within rtapRoot
  const safePath = path.normalize(path.join(rtapRoot, pathname));
  if (!safePath.startsWith(rtapRoot)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('403 Forbidden');
    return;
  }

  fs.stat(safePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end(`404 Not Found: ${pathname}`);
      return;
    }

    const ext = path.extname(safePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': stats.size,
      'Cache-Control': 'no-cache',
    });

    const stream = fs.createReadStream(safePath);
    stream.pipe(res);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[rtap-dashboard] Server running at http://${HOST}:${PORT}/`);
  console.log(`[rtap-dashboard] Direct UI URL: http://${HOST}:${PORT}/dashboard/index.html`);
  console.log(`[rtap-dashboard] Serving RTAP root: ${rtapRoot}`);
});
