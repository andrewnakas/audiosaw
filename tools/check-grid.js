#!/usr/bin/env node
/*
 * Checks the musical grid, the metronome and the count-in in /audio-editor,
 * in headless Chrome, driving the real page:
 *
 *   1. the tempo sheet sets 3/4, the bars ruler and the click, and they are
 *      saved with the project; the clock reads bar.beat.sixteenth
 *   2. a clip dragged in bars mode lands on the grid
 *   3. playing with the click on schedules one click per beat, exactly a
 *      beat apart on the context clock, accented on each downbeat
 *   4. an export of a silent project is silent with the click on: the click
 *      never reaches render()
 *   5. recording with a one-bar count-in (fake microphone) clicks the bar
 *      first, shows the countdown, and places the take at the playhead, not
 *      a bar early
 *
 *   node tools/check-grid.js
 *
 * Needs Google Chrome. Skips (exit 0) when it cannot find it.
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CHROME = [
  process.env.CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'
].filter(Boolean).find((p) => fs.existsSync(p));

if (!CHROME) {
  console.log('check-grid: skipped (no Chrome found; set CHROME=/path/to/chrome to run it).');
  process.exit(0);
}

const TYPES = { '.js': 'application/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {
  let url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/') url = '/index.html';
  let file = path.join(ROOT, url);
  if (!path.extname(file) && fs.existsSync(file + '.html')) file += '.html';
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

const fails = [];
const notes = [];
function ok(cond, msg) { if (!cond) fails.push(msg); }

server.listen(0, '127.0.0.1', async () => {
  const origin = 'http://127.0.0.1:' + server.address().port;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'as-grid-'));
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + dir,
    '--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required',
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });
  let code = 1;
  try {
    const cdp = await connect(dir);
    await cdp.send('Page.enable');
    await cdp.send('Network.enable');
    // Nothing leaves the machine: analytics and fonts are not what is under test.
    await cdp.send('Network.setBlockedURLs', { urls: ['*googletagmanager*', '*google-analytics*', '*fonts.googleapis*', '*fonts.gstatic*', '*unpkg.com*'] });
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: 'try { Object.defineProperty(navigator, "serviceWorker", { value: undefined }); } catch (e) {}'
    });
    const r = makeRunner(cdp, origin);
    await scenario(r, cdp);
    if (fails.length) {
      fails.forEach((f) => console.error('  FAIL ' + f));
      console.error('check-grid: ' + fails.length + ' failure(s).');
    } else {
      notes.forEach((n) => console.log('  ' + n));
      console.log('check-grid: bars ruler, snap to the beat, a sample-locked click that never reaches an export, and a count-in that places the take at the playhead.');
      code = 0;
    }
    cdp.close();
  } catch (e) {
    fails.forEach((f) => console.error('  FAIL ' + f));
    console.error('check-grid: ' + (e.stack || e.message));
  }
  chrome.kill();
  server.close();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  process.exit(code);
});

/* ------------------------------------------------------------ scenario */

async function scenario(r, cdp) {
  await r.open('/audio-editor');
  await r.waitFor('!!window.ASEditEngine && !!document.getElementById("fileInput")');
  // A silent 4 s clip: silence is what makes step 4 a real test.
  await r.eval(`(function () {
    var b = new AudioBuffer({ numberOfChannels: 1, length: 44100 * 4, sampleRate: 44100 });
    var dt = new DataTransfer();
    dt.items.add(new File([AudioSaw.audioBufferToWav(b)], 'silence.wav', { type: 'audio/wav' }));
    var input = document.getElementById('fileInput');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await r.waitSaved();

  // 1. Tempo sheet: 120 BPM, 3/4, bars ruler, click on, one-bar count-in.
  await r.eval('document.getElementById("edMore").click()');
  await r.waitFor('!!document.querySelector(\'#edSheet [data-v="tempo"]\')');
  await r.eval('document.querySelector(\'#edSheet [data-v="tempo"]\').click()');
  await r.waitFor('!!document.querySelector(\'#edSheet [data-k="sig"]\')');
  await r.eval(`(function () {
    var q = function (k) { return document.querySelector('#edSheet [data-k="' + k + '"]'); };
    q('bpm').value = '120'; q('sig').value = '3/4'; q('ruler').checked = true; q('click').checked = true; q('countin').value = '1';
    document.querySelector('#edSheet [data-v="ok"]').click();
  })()`);
  await r.waitSaved();
  let p = await r.project();
  ok(p.sig && p.sig.join('/') === '3/4' && p.ruler === 'bars' && p.bpm === 120, 'the tempo sheet saves 3/4 and the bars ruler with the project (got ' + JSON.stringify([p.sig, p.ruler, p.bpm]) + ')');
  await sleep(100);
  const clock = await r.eval('document.getElementById("edTime").textContent');
  ok(clock === '1.1.1', 'the clock reads bar.beat.sixteenth at 0:00 (got ' + clock + ')');
  ok(await r.eval('ASEditEngine.clickState().on'), 'the metronome is on');

  // 2. Drag the clip right by an arbitrary distance; it must land on the grid
  // (every grid division at any zoom is a multiple of a sixteenth, 0.125 s).
  const rect = await r.eval('(function () { var b = document.getElementById("edLanes").getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width }; })()');
  const x0 = rect.x + 30, y0 = rect.y + 20, x1 = x0 + Math.round(rect.w * 0.137);
  const mouse = (type, x, y) => cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
  await mouse('mousePressed', x0, y0); await mouse('mouseReleased', x0, y0);
  await sleep(150);
  await mouse('mousePressed', x0, y0);
  for (let k = 1; k <= 8; k++) await mouse('mouseMoved', x0 + (x1 - x0) * k / 8, y0);
  await mouse('mouseReleased', x1, y0);
  await r.waitSaved();
  p = await r.project();
  const st = p.tracks[0].clips[0].start, k16 = st / 0.125;
  ok(st > 0.2 && Math.abs(k16 - Math.round(k16)) < 1e-6, 'a dragged clip lands on the beat grid (start ' + st + ' s)');
  notes.push('dragged clip snapped to ' + st.toFixed(3) + ' s');

  // 3. Play with the click on for ~2.1 s (over one 3/4 bar). A short play first, so the effect
  // worklet has loaded: its arrival restarts playback once, which is not
  // what is being measured.
  await r.eval('document.getElementById("edPlay").click()');
  await sleep(500);
  await r.eval('document.getElementById("edPlay").click()');
  await r.eval('document.getElementById("edHome").click()');
  const n0 = (await r.eval('ASEditEngine.clickState().log')).length;
  await r.eval('document.getElementById("edPlay").click()');
  await sleep(2100);
  await r.eval('document.getElementById("edPlay").click()');
  const log = (await r.eval('ASEditEngine.clickState().log')).slice(n0);
  ok(log.length >= 3, 'the click scheduled a beat every half second (' + log.length + ' clicks)');
  let spacing = 0;
  for (let i = 1; i < log.length; i++) spacing = Math.max(spacing, Math.abs(log[i].when - log[i - 1].when - 0.5));
  ok(spacing < 1e-6, 'clicks are exactly one beat apart on the context clock (worst error ' + spacing + ' s)');
  ok(log.slice(0, 4).map((c) => c.accent).join('') === '2002', '3/4 accents the downbeat of each bar (got ' + log.slice(0, 4).map((c) => c.accent).join('') + ')');

  // 4. The export is silent although the click is on.
  const peak = await r.eval(`ASEditEngine.render(${JSON.stringify(p)}, 0, 2, { sampleRate: 44100, channels: 2 }).then(function (b) {
    var m = 0; for (var c = 0; c < b.numberOfChannels; c++) { var d = b.getChannelData(c); for (var i = 0; i < d.length; i++) if (Math.abs(d[i]) > m) m = Math.abs(d[i]); }
    return m;
  })`);
  ok(peak === 0, 'an export with the click on has no click in it (peak ' + peak + ')');

  // 5. Record from 0:00 with a one-bar count-in (3 beats, 1.5 s).
  await r.eval('document.getElementById("edHome").click()');
  const before = (await r.eval('ASEditEngine.clickState().log')).length;
  await r.eval('document.getElementById("edRec").click()');
  await r.waitFor('!document.getElementById("edCount").hidden', 8000);
  const shown = await r.eval('document.getElementById("edCount").textContent');
  ok(/^[123]$/.test(shown), 'the countdown shows beats left (' + shown + ')');
  await r.waitFor('document.getElementById("edCount").hidden', 5000);
  await sleep(1500);
  await r.eval('document.getElementById("edRec").click()');
  await r.waitFor('/Recorded/.test(document.getElementById("status").textContent)', 10000);
  await r.waitSaved();
  p = await r.project();
  const takes = [];
  p.tracks.forEach((t) => t.clips.forEach((c) => { if (/^Take/.test(c.name)) takes.push(c); }));
  ok(takes.length === 1, 'one take was recorded (' + takes.length + ')');
  if (takes[0]) {
    ok(Math.abs(takes[0].start) < 1e-6, 'the take starts at the playhead, not a bar early (start ' + takes[0].start + ')');
    ok(takes[0].duration > 1.2 && takes[0].duration < 2.4, 'the take holds what came after the count-in, not the count-in (' + takes[0].duration.toFixed(2) + ' s)');
    notes.push('take after a one-bar count-in: start ' + takes[0].start + ' s, ' + takes[0].duration.toFixed(2) + ' s long');
  }
  const cl = await r.eval('ASEditEngine.clickState().log');
  ok(cl.length - before >= 6, 'the count-in and the take both clicked (' + (cl.length - before) + ' clicks)');
}

/* -------------------------------------------------------------- runner */

function makeRunner(cdp, origin) {
  async function evaluate(expr) {
    const res = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, timeout: 120000 });
    if (res.result && res.result.exceptionDetails) {
      const d = res.result.exceptionDetails;
      throw new Error('in page: ' + ((d.exception && d.exception.description) || d.text));
    }
    return res.result && res.result.result ? res.result.result.value : undefined;
  }
  async function waitFor(expr, ms) {
    const until = Date.now() + (ms || 15000);
    let last = null;
    while (Date.now() < until) {
      try { if (await evaluate('!!(' + expr + ')')) return; } catch (e) { last = e; }
      await sleep(100);
    }
    const status = await evaluate('(document.getElementById("status") || {}).textContent || ""').catch(() => '');
    throw new Error('timed out waiting for: ' + expr + (status ? '\n  page status: ' + status : '') + (last ? '\n  ' + last.message : ''));
  }
  const readProject = `(function () {
    return new Promise(function (res, rej) {
      var r = indexedDB.open('audiosaw-editor', 1);
      r.onerror = function () { rej(r.error); };
      r.onsuccess = function () {
        var g = r.result.transaction('meta').objectStore('meta').get('project');
        g.onsuccess = function () { r.result.close(); res(g.result); };
      };
    });
  })()`;
  return {
    eval: evaluate,
    waitFor,
    open: async (p) => { await cdp.send('Page.navigate', { url: origin + p }); await sleep(300); },
    waitSaved: async () => {
      await sleep(300);
      await waitFor('document.getElementById("edSaved").dataset.state === "saved"', 15000);
    },
    project: async () => JSON.parse(await evaluate(readProject))
  };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function connect(dir) {
  const f = path.join(dir, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !fs.existsSync(f); i++) await sleep(100);
  const port = fs.readFileSync(f, 'utf8').split('\n')[0];
  return attach(port, null);
}

async function attach(port, targetId) {
  const pick = (list) => list.find((t) => t.type === 'page' && (!targetId || t.id === targetId));
  let list = [];
  for (let i = 0; i < 50 && !pick(list); i++) {
    list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
    if (!pick(list)) await sleep(100);
  }
  const ws = new WebSocket(pick(list).webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
  return {
    send: (method, params) => new Promise((r) => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); }),
    close: () => ws.close(),
    port
  };
}
