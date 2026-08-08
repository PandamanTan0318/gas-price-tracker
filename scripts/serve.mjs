#!/usr/bin/env node
// Serves docs/ locally so the page can be checked before it goes live.
//
// Exists because opening docs/index.html with file:// does not work: the page
// is an ES module and fetches prices.json, both of which browsers block over
// file://. No dependency is needed, because node's http module is enough.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', 'docs');
const PORT = Number(process.env.PORT) || 4173;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
  const path = join(ROOT, rel === '' ? 'index.html' : rel);

  // Refuse anything that climbed out of docs/. This binds to localhost, but a
  // path-traversal hole in a dev server is still a path-traversal hole.
  if (!path.startsWith(ROOT)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const body = await readFile(path);
    res.writeHead(200, {
      'content-type': TYPES[extname(path)] ?? 'application/octet-stream',
      // Matches the page's own cache-busting intent: never serve a stale price
      // file while checking a change.
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
  }
}).listen(PORT, () => {
  console.log(`Serving docs/ on http://localhost:${PORT}`);
});
