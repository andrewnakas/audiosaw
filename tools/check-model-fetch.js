#!/usr/bin/env node
/*
 * The resumable fetch in js/transcribe-worker.js, against a server that drops
 * every response after 2 MB and honours Range. The model files are 80-220 MB
 * and a slow link drops them partway (measured: the base decoder failed at 67
 * of 117 MB, twice), so the download has to carry on from the byte it reached
 * and hand transformers.js one complete, byte-exact response.
 *
 * The function is lifted out of the worker source rather than duplicated, so
 * this tests the code that ships. It needs Node 18+ (fetch, ReadableStream).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'transcribe-worker.js'), 'utf8');
const a = src.indexOf('var plainFetch'), b = src.indexOf('env.fetch = resumableFetch;');
if (a < 0 || b < 0) { console.error('check-model-fetch: resumableFetch not found in transcribe-worker.js'); process.exit(1); }
const make = new Function('self', src.slice(a, b) + '; return resumableFetch;');

const SIZE = 6 * 1048576 + 12345;
const data = Buffer.alloc(SIZE);
for (let i = 0; i < SIZE; i++) data[i] = (i * 7 + (i >> 9)) & 255;

function serve(mode) {
  const log = [];
  const server = http.createServer((req, res) => {
    const range = req.headers.range;
    log.push(range || 'full');
    let start = 0;
    if (range && mode !== 'no-range') {
      start = +/bytes=(\d+)-/.exec(range)[1];
      res.writeHead(206, { 'content-length': SIZE - start, 'content-range': `bytes ${start}-${SIZE - 1}/${SIZE}` });
    } else res.writeHead(200, { 'content-length': SIZE });
    const end = mode === 'clean' ? SIZE : Math.min(SIZE, start + 2 * 1048576);
    res.write(data.subarray(start, end), () => { if (end < SIZE) res.socket.destroy(); else res.end(); });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, log, url: `http://127.0.0.1:${server.address().port}/m.onnx` })));
}

(async () => {
  let failed = 0;
  const ok = (c, m) => { if (!c) { failed++; console.log('  FAIL ' + m); } };
  const f = make(globalThis);

  // 1. Drops every 2 MB: resumes three times, bytes exact.
  let s = await serve('drop');
  let buf = Buffer.from(await (await f(s.url)).arrayBuffer());
  ok(buf.length === SIZE && buf.equals(data), `resumed download is byte-exact (got ${buf.length})`);
  ok(s.log.join() === 'full,bytes=2097152-,bytes=4194304-,bytes=6291456-', `resumes from the byte it reached: ${s.log.join(' ')}`);
  s.server.close();

  // 2. A clean download is untouched: one request.
  s = await serve('clean');
  buf = Buffer.from(await (await f(s.url)).arrayBuffer());
  ok(buf.equals(data) && s.log.length === 1, 'clean download is one request');
  s.server.close();

  // 3. A server that ignores Range must not splice byte 0 onto the middle.
  s = await serve('no-range');
  let threw = false;
  try { await (await f(s.url)).arrayBuffer(); } catch (e) { threw = true; }
  ok(threw, 'a server without Range support fails loudly instead of corrupting the file');
  s.server.close();

  if (failed) { console.log(`check-model-fetch: ${failed} failure(s)`); process.exit(1); }
  console.log('check-model-fetch: model downloads resume byte-exact after a dropped connection');
})();
