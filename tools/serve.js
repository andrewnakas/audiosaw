#!/usr/bin/env node
/*
 * Serve the repo the way Cloudflare Pages does: extensionless URLs map to
 * .html, and every rule in _headers is applied. The second part is the point.
 * /stem-splitter and /audio-to-text only work cross-origin isolated, and a
 * plain static server leaves out COOP/COEP, so SharedArrayBuffer is missing
 * and the page looks broken in a way production is not.
 *
 *   node tools/serve.js [port]          # default 8788
 *   const { start } = require('./serve'); const s = await start(0);  // s.port, s.close()
 *
 * Only the subset of _headers this repo uses: exact paths, a trailing '*',
 * and '*' inside a segment ('/*.wasm'). Later rules add to earlier ones, as
 * on Pages.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TYPES = {
  '.js': 'application/javascript', '.mjs': 'application/javascript', '.html': 'text/html; charset=utf-8',
  '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml', '.webmanifest': 'application/manifest+json',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.flac': 'audio/flac'
};

function parseHeaders() {
  const rules = [];
  let cur = null;
  fs.readFileSync(path.join(ROOT, '_headers'), 'utf8').split('\n').forEach((line) => {
    if (!line.trim() || /^\s*#/.test(line)) return;
    if (!/^\s/.test(line)) {
      const pat = line.trim();
      const re = new RegExp('^' + pat.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
      cur = { re, headers: [] };
      rules.push(cur);
    } else if (cur) {
      const i = line.indexOf(':');
      if (i > 0) cur.headers.push([line.slice(0, i).trim(), line.slice(i + 1).trim()]);
    }
  });
  return rules;
}

function start(port) {
  const rules = parseHeaders();
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    let file = path.join(ROOT, url === '/' ? '/index.html' : url);
    if (!path.extname(file) && fs.existsSync(file + '.html')) file += '.html';
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return;
    }
    const headers = { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' };
    rules.forEach((r) => { if (r.re.test(url)) r.headers.forEach(([k, v]) => { headers[k.toLowerCase()] = v; }); });
    // Pages' long cache would pin a stale file during development.
    headers['cache-control'] = 'no-store';
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({
    port: server.address().port,
    close: () => new Promise((r) => server.close(r))
  })));
}

module.exports = { start, parseHeaders };

if (require.main === module) {
  start(+process.argv[2] || 8788).then((s) => console.log('serving http://localhost:' + s.port));
}
