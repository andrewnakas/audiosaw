/*
 * Headless Chrome for the checks that need Web Audio.
 *
 * The same few dozen lines as the top of check-fx.js: serve the repo, start
 * Chrome with a DevTools port, evaluate an expression in the page and hand
 * back its value. check-fx.js and check-project-link.js carry their own copies;
 * new checks use this one.
 *
 *   const { findChrome, withPage } = require('./chrome-harness');
 *   await withPage({ routes: { '/__x': html } }, async (page) => {
 *     await page.goto('/__x');
 *     const v = await page.eval('window.__run()');
 *     page.listen('Fetch.requestPaused', (p) => ...);   // any CDP event
 *   });
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TYPES = {
  '.js': 'application/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json',
  '.wav': 'audio/wav', '.flac': 'audio/flac', '.mp3': 'audio/mpeg', '.wasm': 'application/wasm', '.svg': 'image/svg+xml'
};

function findChrome() {
  return [
    process.env.CHROME,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'
  ].filter(Boolean).find((p) => fs.existsSync(p));
}

// routes: { '/path': string | Buffer | () => Buffer }. Everything else is
// served from the repo; an extensionless path gets '.html', like Pages does.
async function withPage(opts, fn) {
  const routes = opts.routes || {};
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    if (Object.prototype.hasOwnProperty.call(routes, url)) {
      let body = routes[url];
      if (typeof body === 'function') body = body();
      const type = typeof body === 'string' ? 'text/html' : (TYPES[path.extname(url)] || 'application/octet-stream');
      // Open to any origin: a route can stand in for a CDN file the page
      // fetches with CORS (see check-fidelity's ffmpeg core).
      res.writeHead(200, { 'content-type': type, 'access-control-allow-origin': '*' });
      res.end(body);
      return;
    }
    let file = path.join(ROOT, url === '/' ? '/index.html' : url);
    if (!path.extname(file) && fs.existsSync(file + '.html')) file += '.html';
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'as-chk-'));
  const chrome = spawn(findChrome(), ['--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + dir,
    '--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required',
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', 'about:blank'], { stdio: 'ignore' });
  let ws;
  try {
    ws = await connect(dir);
    let id = 0;
    const pending = new Map();
    const logs = [];
    const listeners = {};
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.method && listeners[d.method]) listeners[d.method].forEach((fn) => fn(d.params));
      if (d.method === 'Runtime.exceptionThrown') logs.push('exception: ' + JSON.stringify(d.params.exceptionDetails).slice(0, 400));
      if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') logs.push('console.error: ' + d.params.args.map((a) => a.value || a.description).join(' '));
      if (pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
    };
    const send = (method, params) => new Promise((r) => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
    await send('Page.enable');
    await send('Runtime.enable');
    const page = {
      port, logs, send,
      listen(method, fn) { (listeners[method] = listeners[method] || []).push(fn); },
      url: (p) => 'http://127.0.0.1:' + port + p,
      async goto(p, wait) {
        await send('Page.navigate', { url: page.url(p) });
        await new Promise((r) => setTimeout(r, wait || 800));
      },
      async eval(expression, timeout) {
        const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout: timeout || 300000 });
        if (res.result && res.result.exceptionDetails) {
          const ex = res.result.exceptionDetails;
          throw new Error((ex.exception && ex.exception.description) || JSON.stringify(ex).slice(0, 800));
        }
        return res.result.result.value;
      }
    };
    return await fn(page);
  } finally {
    try { ws && ws.close(); } catch (e) {}
    chrome.kill();
    server.close();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  }
}

async function connect(dir) {
  const f = path.join(dir, 'DevToolsActivePort');
  for (let i = 0; i < 300 && !fs.existsSync(f); i++) await new Promise((r) => setTimeout(r, 100));
  const port = fs.readFileSync(f, 'utf8').split('\n')[0];
  let list = [];
  for (let i = 0; i < 50 && !list.some((t) => t.type === 'page'); i++) {
    list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
    if (!list.some((t) => t.type === 'page')) await new Promise((r) => setTimeout(r, 100));
  }
  const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  return ws;
}

module.exports = { findChrome, withPage, ROOT };
