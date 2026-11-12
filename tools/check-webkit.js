#!/usr/bin/env node
/*
 * Whisper in WebKit: /censor-audio in Playwright's WebKit, the engine of
 * Safari and of every browser on an iPhone or iPad.
 *
 * Why it exists (12 Nov 2026): GA4 showed every Whisper tool failing on
 * Safari (censor-audio 8 starts, 8 errors; the others 7 starts, 1 success),
 * and nothing here ran WebKit. Run in WebKit, three faults showed:
 *   - the library's "Range: bytes=0-0" size probe came back as the whole
 *     file (WebKit drops Range across the CDN redirect), resumableFetch
 *     treated it as a download, and the library cancelled it partway;
 *   - the cancelled stream was taken for a dropped connection and resumed,
 *     ~15 KB per request: 28 of 139 MB in 200 s;
 *   - Safari reports a WebGPU adapter, but WebKit gets the plain ORT build,
 *     which has none: "webgpuInit is not a function", and the CPU fallback
 *     then refused to start in the same worker.
 *
 * Requires: Playwright with WebKit in ~/.cache/audiosaw/playwright
 *   (cd ~/.cache/audiosaw/playwright && npm i playwright && npx playwright install webkit)
 * and WEBKIT=1, because it downloads the 139 MB model from Hugging Face (a
 * WebKit worker's requests could not be routed to the local mirror).
 * Holds: the model downloads once (no second pass after the probe), within
 * 3 minutes, and the transcript has the words of a `say` sentence.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const PW = path.join(os.homedir(), '.cache', 'audiosaw', 'playwright', 'node_modules', 'playwright');
if (!process.env.WEBKIT) { console.log('check-webkit: skipped (WEBKIT=1 runs Whisper in WebKit, ~140 MB download)'); process.exit(0); }
if (!fs.existsSync(PW)) { console.log('check-webkit: skipped (no Playwright in ~/.cache/audiosaw/playwright)'); process.exit(0); }
const { webkit } = require(PW);

let failed = 0;
const ok = (c, m) => { console.log((c ? '  ok  ' : '  FAIL ') + m); if (!c) failed++; };

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'as-webkit-'));
  const wav = path.join(dir, 's.wav');
  execFileSync('say', ['-v', 'Daniel', '-o', path.join(dir, 's.aiff'), 'What the hell is this? It is a damn good test of the system.']);
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', path.join(dir, 's.aiff'), '-ar', '48000', wav]);
  const { start } = require('./serve');
  const s = await start(0);
  const browser = await webkit.launch();
  try {
    const ctx = await browser.newContext();
    await ctx.route(/scriptwrapper|googletagmanager/, (r) => r.abort());
    const full = {};
    ctx.on('requestfinished', async (r) => {
      const m = /\/onnx\/([^?]+)/.exec(r.url());
      if (m && !r.headers().range) full[m[1]] = (full[m[1]] || 0) + 1;
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('http://127.0.0.1:' + s.port + '/censor-audio');
    await page.setInputFiles('#fileInput', wav);
    const t0 = Date.now();
    const r = await page.evaluate(() => window.__censor.analyse().then(
      () => ({ words: window.__censor.words().map((w) => w.text.trim()).join(' ') }),
      (e) => ({ err: e.message || String(e) })));
    const secs = (Date.now() - t0) / 1000;
    if (r.err) ok(false, 'WebKit: ' + r.err + ' (status: ' + await page.textContent('#status') + ')');
    else {
      const want = ['what', 'hell', 'damn', 'test', 'system'];
      ok(want.every((w) => r.words.toLowerCase().indexOf(w) >= 0), 'WebKit transcribes it: "' + r.words + '"');
      ok(secs < 180, 'in ' + secs.toFixed(0) + ' s, model download included');
    }
    const twice = Object.keys(full).filter((k) => full[k] > 1);
    ok(Object.keys(full).length >= 2 && !twice.length, 'each model file downloaded once (' + Object.keys(full).map((k) => k + ' x' + full[k]).join(', ') + ')');
    ok(!errors.length, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  } finally { await browser.close(); s.close(); }
  if (failed) { console.log('\ncheck-webkit: ' + failed + ' failed'); process.exit(1); }
  console.log('\ncheck-webkit: Whisper runs in WebKit');
})().catch((e) => { console.error(e); process.exit(1); });
