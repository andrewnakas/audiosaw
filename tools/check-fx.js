#!/usr/bin/env node
/*
 * Checks the audio editor's real-time effects (js/editor-dsp.js) and mixer
 * (js/editor-engine.js) by running them in headless Chrome, since Web Audio
 * exists nowhere else.
 *
 * Every plugin, at its defaults and at every factory preset, is rendered over
 * noise and a sine sweep and must:
 *
 *   - produce finite samples that stay under +6 dBFS
 *   - give back the dry signal at Mix 0 (for plugins that have a Mix)
 *   - sound the same whether its parameters were set live or at build time,
 *     because live edits during playback go through set()
 *   - render identically twice, or playback and export could differ
 *
 * and the numbers the page quotes are measured, not assumed:
 *
 *   - the compressor takes 7.5 dB off a tone 10 dB over threshold at 4:1
 *   - an EQ band at +6 dB boosts a tone at its centre by 6 dB
 *   - the limiter's true peak (BS.1770, via js/loudness.js) stays under its ceiling
 *   - the multiband's three bands sum back flat
 *   - the limiter's latency is what it declares, and the mixer pads the other
 *     tracks to match, so a limited track stays in time
 *   - volume automation lands where it was drawn, and tails ring past the end
 *
 *   node tools/check-fx.js
 *
 * Needs Google Chrome. Skips (exit 0) when it cannot find it, so check-all
 * still runs on a machine without one.
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
  console.log('check-fx: skipped (no Chrome found; set CHROME=/path/to/chrome to run it).');
  process.exit(0);
}

const PAGE = `<!doctype html><meta charset="utf-8"><title>fx check</title>
<script src="/js/editor-model.js"></script>
<script src="/js/loudness.js"></script>
<script src="/js/editor-dsp.js"></script>
<script src="/js/editor-engine.js"></script>
<script>window.__run = ${pageTests.toString()};</script>`;

const TYPES = { '.js': 'application/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/__fx') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE); return; }
  const file = path.join(ROOT, url);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'as-fx-'));
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + dir,
    '--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore' });
  let code = 1;
  try {
    const ws = await connect(dir);
    let id = 0;
    const pending = new Map();
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
    const send = (method, params) => new Promise((r) => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
    await send('Page.enable');
    await send('Page.navigate', { url: 'http://127.0.0.1:' + port + '/__fx' });
    await new Promise((r) => setTimeout(r, 800));
    const res = await send('Runtime.evaluate', { expression: process.env.FX_EVAL || 'window.__run()', awaitPromise: true, returnByValue: true, timeout: 180000 });
    if (res.result.exceptionDetails) throw new Error(JSON.stringify(res.result.exceptionDetails).slice(0, 800));
    const out = res.result.result.value;
    out.notes.forEach((n) => console.log('  ' + n));
    out.fails.forEach((f) => console.error('  FAIL ' + f));
    if (out.fails.length) console.error('check-fx: ' + out.fails.length + ' failure(s) across ' + out.renders + ' renders.');
    else { console.log('check-fx: ' + out.plugins + ' plugins and ' + out.presets + ' presets render clean; ' + out.renders + ' renders, every measured claim holds.'); code = 0; }
    ws.close();
  } catch (e) {
    console.error('check-fx: ' + e.message);
  }
  chrome.kill();
  server.close();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  process.exit(code);
});

async function connect(dir) {
  const f = path.join(dir, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !fs.existsSync(f); i++) await new Promise((r) => setTimeout(r, 100));
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

/* -------------------------------------------------- runs in the page */

async function pageTests() {
  const D = window.ASEditDsp, M = window.ASEditModel, E = window.ASEditEngine, L = window.ASLoudness;
  const SR = 48000, fails = [], notes = [];
  let renders = 0, presets = 0;
  const fail = (m) => fails.push(m);
  const db = (x) => 20 * Math.log10(Math.max(1e-12, x));

  function signal(len, kind) {
    const b = new AudioBuffer({ numberOfChannels: 2, length: len, sampleRate: SR });
    const L0 = b.getChannelData(0), R0 = b.getChannelData(1);
    let s = 1, b0 = 0, b1 = 0, b2 = 0;
    const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff * 2 - 1; };
    for (let i = 0; i < len; i++) {
      const t = i / SR;
      if (kind === 'sine') { L0[i] = R0[i] = 0.316 * Math.sin(2 * Math.PI * 1000 * t); continue; }
      const w = rnd();
      b0 = 0.99765 * b0 + w * 0.099; b1 = 0.963 * b1 + w * 0.2965; b2 = 0.57 * b2 + w * 1.0527;
      const pink = (b0 + b1 + b2 + w * 0.1848) * 0.05;
      const f = 50 * Math.pow(400, t / (len / SR));
      const sweep = 0.2 * Math.sin(2 * Math.PI * 50 * (len / SR) / Math.log(400) * (Math.pow(400, t / (len / SR)) - 1));
      L0[i] = pink + sweep; R0[i] = pink * 0.8 - sweep * 0.9;
      void f;
    }
    return b;
  }

  // Render `input` through one plugin slot. `live` applies the params with
  // set() after building from defaults instead of building with them.
  async function run(slot, input, opts) {
    opts = opts || {};
    const off = new OfflineAudioContext(2, input.length + (opts.extra || 0), SR);
    await D.ensureWorklet(off);
    const src = off.createBufferSource(); src.buffer = input;
    const key = off.createBufferSource(); key.buffer = opts.key || input;
    const env = { bpm: 120, key: () => key };
    let inst;
    if (opts.live) {
      // Built from defaults with only the shape-defining parameters taken
      // from the target, the way a live edit starts from a running plugin.
      const start = D.defaults(slot.type);
      D.PLUGINS[slot.type].structural.forEach((k) => { start[k] = slot.params[k]; });
      inst = D.create(off, { id: 'x', type: slot.type, params: start }, env);
      inst.set(slot.params, true);
    } else inst = D.create(off, slot, env);
    src.connect(inst.in); inst.out.connect(off.destination);
    src.start(0); key.start(0);
    const out = await off.startRendering();
    renders++;
    return { out, inst };
  }
  function stats(buf, from) {
    let peak = 0, bad = 0;
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c);
      for (let i = from || 0; i < d.length; i++) { const v = d[i]; if (!isFinite(v)) bad++; else if (Math.abs(v) > peak) peak = Math.abs(v); }
    }
    return { peak, bad };
  }
  function maxDiff(a, b, from) {
    let m = 0;
    for (let c = 0; c < 2; c++) {
      const x = a.getChannelData(c), y = b.getChannelData(c);
      for (let i = from || 0; i < Math.min(x.length, y.length); i++) m = Math.max(m, Math.abs(x[i] - y[i]));
    }
    return m;
  }

  const noise = signal(SR * 1.5, 'mix');

  for (const type of D.ORDER) {
    const def = D.PLUGINS[type];
    const cases = [{ name: 'defaults', slot: Object.assign({ id: 'x', type }, D.fresh(type)) }]
      .concat(def.presets.map((p) => ({ name: p.name, slot: Object.assign({ id: 'x', type }, D.presetSlot(type, p.name)) })));
    for (const cs of cases) {
      presets++;
      const slot = cs.slot;
      if (type === 'ducker') slot.params.src = 'key';
      const a = await run(slot, noise, { extra: SR / 2 });
      const st = stats(a.out);
      const where = type + ' / ' + cs.name;
      if (a.inst.note && type !== 'ducker') fail(where + ': ' + a.inst.note);
      if (st.bad) fail(where + ': ' + st.bad + ' non-finite samples');
      if (st.peak > 2) fail(where + ': peak ' + db(st.peak).toFixed(1) + ' dBFS');
      if (st.peak < 1e-4 && type !== 'gate') fail(where + ': silent output');
      const b = await run(slot, noise, { extra: SR / 2 });
      // Not bit-exact: Chrome's DelayNode, with its delay time modulated by
      // two oscillators, measured up to 2.3e-4 (-73 dB) apart between two
      // identical renders of the tape plugin, and only at some settings. A
      // random impulse response or an unseeded noise source differs at -10 dB.
      const rep = maxDiff(a.out, b.out);
      if (rep > 1e-3) fail(where + ': two renders differ by ' + rep.toExponential(2));
      // Live set() must land where a fresh build does. Plugins that regenerate
      // on a structural change are rebuilt live too, so only compare same-shape.
      {
        const c = await run(slot, noise, { live: true, extra: SR / 2 });
        // Skip the first 50 ms: set() glides, a fresh build starts in place.
        const d = maxDiff(a.out, c.out, Math.round(SR * 0.25));
        if (d > 2e-3) fail(where + ': live set() differs from a fresh build by ' + db(d).toFixed(1) + ' dB');
      }
    }
    if (def.byKey.mix) {
      const slot = Object.assign({ id: 'x', type }, D.fresh(type));
      slot.params.mix = 0;
      if (type === 'ducker') slot.params.src = 'key';
      const r = await run(slot, noise);
      const d = maxDiff(r.out, noise);
      if (d > 1e-5) fail(type + ': Mix 0 is not the dry signal (differs by ' + db(d).toFixed(1) + ' dB)');
    }
  }

  /* ---- measured claims */
  const sine = signal(SR * 2, 'sine');   // 1 kHz at -10 dBFS peak
  {
    const slot = { id: 'x', type: 'comp', params: Object.assign(D.defaults('comp'), { thresh: -20, ratio: 4, knee: 0, attack: 5, release: 100, auto: 'off', makeup: 0 }) };
    const r = await run(slot, sine);
    const pk = db(stats(r.out, SR).peak), gr = -10 - pk;
    notes.push('compressor: 10 dB over threshold at 4:1 -> ' + gr.toFixed(2) + ' dB of gain reduction (expected 7.5)');
    if (Math.abs(gr - 7.5) > 0.4) fail('compressor gain reduction ' + gr.toFixed(2) + ' dB, expected 7.5');
  }
  {
    const slot = { id: 'x', type: 'eq', params: Object.assign(D.defaults('eq'), { p3Freq: 1000, p3Gain: 6, p3Q: 1 }) };
    const r = await run(slot, sine);
    const g = db(stats(r.out, SR).peak) - db(stats(sine).peak);
    notes.push('EQ: +6 dB band at 1 kHz boosts a 1 kHz tone by ' + g.toFixed(2) + ' dB');
    if (Math.abs(g - 6) > 0.3) fail('EQ boost ' + g.toFixed(2) + ' dB, expected 6 +/- 0.3');
  }
  {
    const loud = signal(SR * 2, 'mix');
    for (const ceil of [-1, -3]) {
      const slot = { id: 'x', type: 'limiter', params: Object.assign(D.defaults('limiter'), { gain: 18, ceiling: ceil, release: 60 }) };
      const r = await run(slot, loud, { extra: 1024 });
      const tp = db(L.truePeak([r.out.getChannelData(0), r.out.getChannelData(1)]));
      const sp = db(stats(r.out).peak);
      notes.push('limiter: +18 dB into a ' + ceil + ' dBTP ceiling -> true peak ' + tp.toFixed(2) + ' dBTP, sample peak ' + sp.toFixed(2) + ' dBFS');
      if (tp > ceil + 0.1) fail('limiter true peak ' + tp.toFixed(2) + ' dBTP over a ' + ceil + ' ceiling');
    }
    // Latency: a click comes out exactly `latency` samples late.
    const click = new AudioBuffer({ numberOfChannels: 2, length: 4096, sampleRate: SR });
    click.getChannelData(0)[100] = click.getChannelData(1)[100] = 0.25;
    const r = await run({ id: 'x', type: 'limiter', params: D.defaults('limiter') }, click);
    let at = -1, best = 0;
    const d0 = r.out.getChannelData(0);
    for (let i = 0; i < d0.length; i++) if (Math.abs(d0[i]) > best) { best = Math.abs(d0[i]); at = i; }
    const lat = Math.round(D.latencyOf({ type: 'limiter', params: {} }, SR) * SR);
    if (at - 100 !== lat) fail('limiter latency measured ' + (at - 100) + ' samples, declared ' + lat);
    else notes.push('limiter: ' + lat + ' samples of look-ahead, as declared');
  }
  {
    // All ratios 1:1 and gains flat: the crossovers must sum back flat.
    const slot = { id: 'x', type: 'multiband', params: Object.assign(D.defaults('multiband'), { lRatio: 1, mRatio: 1, hRatio: 1 }) };
    let worst = 0;
    for (const f of [60, 200, 700, 3000, 9000]) {
      const b = new AudioBuffer({ numberOfChannels: 2, length: SR, sampleRate: SR });
      for (let i = 0; i < SR; i++) b.getChannelData(0)[i] = b.getChannelData(1)[i] = 0.25 * Math.sin(2 * Math.PI * f * i / SR);
      const r = await run(slot, b);
      worst = Math.max(worst, Math.abs(db(stats(r.out, SR / 2).peak / 0.25)));
    }
    notes.push('multiband: bands at 1:1 sum back within ' + worst.toFixed(2) + ' dB');
    if (worst > 0.2) fail('multiband crossovers do not sum flat: ' + worst.toFixed(2) + ' dB');
  }
  {
    const slot = { id: 'x', type: 'pitch', params: Object.assign(D.defaults('pitch'), { semi: 12 }) };
    const b = new AudioBuffer({ numberOfChannels: 2, length: SR, sampleRate: SR });
    for (let i = 0; i < SR; i++) b.getChannelData(0)[i] = b.getChannelData(1)[i] = 0.3 * Math.sin(2 * Math.PI * 220 * i / SR);
    const r = await run(slot, b);
    // Count the strongest bin by a direct DFT scan around 440 Hz.
    const d = r.out.getChannelData(0).subarray(SR / 4, SR / 4 + 8192);
    let bestF = 0, bestP = 0;
    for (let f = 200; f <= 900; f += 5) {
      let re = 0, im = 0;
      for (let i = 0; i < d.length; i++) { re += d[i] * Math.cos(2 * Math.PI * f * i / SR); im += d[i] * Math.sin(2 * Math.PI * f * i / SR); }
      const p = re * re + im * im;
      if (p > bestP) { bestP = p; bestF = f; }
    }
    notes.push('pitch shifter: 220 Hz up 12 semitones -> ' + bestF + ' Hz');
    if (Math.abs(bestF - 440) > 10) fail('pitch shifter +12 gave ' + bestF + ' Hz, expected 440');
  }
  {
    const r = await run({ id: 'x', type: 'utility', params: Object.assign(D.defaults('utility'), { width: 0 }) }, noise);
    const d = maxDiff({ numberOfChannels: 2, getChannelData: (c) => r.out.getChannelData(c) }, { getChannelData: (c) => r.out.getChannelData(1 - c) });
    if (d > 1e-6) fail('utility width 0 is not mono');
  }

  /* ---- the mixer, through the real engine */
  {
    const p = M.create('t');
    const buf = new AudioBuffer({ numberOfChannels: 1, length: SR * 2, sampleRate: SR });
    for (let i = 0; i < buf.length; i++) buf.getChannelData(0)[i] = 0.25 * Math.sin(2 * Math.PI * 500 * i / SR);
    E.buffers.set('s1', buf);
    M.addSource(p, { id: 's1', duration: 2, channels: 1, sampleRate: SR });
    const t1 = M.addTrack(p);
    M.addClip(p, t1, { sourceId: 's1', start: 0 });
    // Plain: a mono clip at centre is 0.707 per side, as before the mixer.
    let r = await E.render(p, 0, 2, { sampleRate: SR, protect: false });
    renders++;
    let pk = stats(r.buffer, SR / 2).peak;
    if (Math.abs(db(pk) - db(0.25 * Math.SQRT1_2)) > 0.05) fail('mono clip at centre is ' + db(pk).toFixed(2) + ' dB, expected ' + db(0.25 * Math.SQRT1_2).toFixed(2));
    // A flat EQ changes nothing.
    M.addFx(p, t1, 'eq', D.defaults('eq'));
    r = await E.render(p, 0, 2, { sampleRate: SR, protect: false }); renders++;
    if (Math.abs(db(stats(r.buffer, SR / 2).peak) - db(pk)) > 0.05) fail('a flat EQ changed the level');
    // Volume automation: -12 dB from 1 s.
    M.setAutoPoints(p, t1, 'vol', [[0.99, 0], [1.0, -12]]);
    r = await E.render(p, 0, 2, { sampleRate: SR, protect: false }); renders++;
    const d0 = r.buffer.getChannelData(0);
    let a = 0, b = 0;
    for (let i = 0; i < Math.floor(SR * 0.9); i++) a = Math.max(a, Math.abs(d0[i]));
    for (let i = Math.floor(SR * 1.1); i < SR * 2; i++) b = Math.max(b, Math.abs(d0[i]));
    const drop = db(a) - db(b);
    notes.push('mixer: volume automation drew -12 dB, rendered ' + (-drop).toFixed(2) + ' dB');
    if (Math.abs(drop - 12) > 0.2) fail('volume automation dropped ' + drop.toFixed(2) + ' dB, expected 12');
    M.clearAuto(p, t1, 'vol');
    // Pan hard left: unity on the left, silence on the right.
    M.setTrack(p, t1, { pan: -1 });
    r = await E.render(p, 0, 2, { sampleRate: SR, protect: false }); renders++;
    const pl = stats({ numberOfChannels: 1, getChannelData: () => r.buffer.getChannelData(0) }, SR / 2).peak;
    const pr = stats({ numberOfChannels: 1, getChannelData: () => r.buffer.getChannelData(1) }, SR / 2).peak;
    if (Math.abs(db(pl) - db(0.25)) > 0.05 || pr > 1e-4) fail('hard-left pan: L ' + db(pl).toFixed(2) + ' dB, R ' + db(pr).toFixed(2) + ' dB');
    M.setTrack(p, t1, { pan: 0 });

    // Latency compensation: a click on two tracks, one with a limiter,
    // must land on the same sample.
    const click = new AudioBuffer({ numberOfChannels: 1, length: SR, sampleRate: SR });
    click.getChannelData(0)[4800] = 0.5;
    E.buffers.set('c1', click);
    const q = M.create('lat');
    M.addSource(q, { id: 'c1', duration: 1, channels: 1, sampleRate: SR });
    const ta = M.addTrack(q), tb = M.addTrack(q);
    M.addClip(q, ta, { sourceId: 'c1', start: 0 });
    M.addClip(q, tb, { sourceId: 'c1', start: 0 });
    M.addFx(q, tb, 'limiter', D.defaults('limiter'));
    M.setTrack(q, ta, { pan: -1 }); M.setTrack(q, tb, { pan: 1 });
    r = await E.render(q, 0, 1, { sampleRate: SR, protect: false }); renders++;
    const peakAt = (d) => { let m = 0, at = -1; for (let i = 0; i < d.length; i++) if (Math.abs(d[i]) > m) { m = Math.abs(d[i]); at = i; } return at; };
    const la = peakAt(r.buffer.getChannelData(0)), lb = peakAt(r.buffer.getChannelData(1));
    if (la !== 4800 || lb !== 4800) fail('latency compensation: clicks at ' + la + ' and ' + lb + ', expected both at 4800');
    else notes.push('mixer: a limited track and a dry one stay sample-aligned, and the export trims the look-ahead');

    // Tails: a reverb rings past the end of the clip only when asked.
    M.addFx(p, t1, 'reverb', Object.assign(D.defaults('reverb'), { size: 2, mix: 50 }));
    r = await E.render(p, 0, 2, { sampleRate: SR, protect: false }); renders++;
    const cut = r.buffer.length;
    r = await E.render(p, 0, 2, { sampleRate: SR, protect: false, tails: true }); renders++;
    if (cut !== SR * 2) fail('a render without tails is ' + cut + ' samples, expected ' + SR * 2);
    if (r.buffer.length < SR * 3) fail('a 2 s reverb tail only extended the export to ' + (r.buffer.length / SR).toFixed(2) + ' s');
    else notes.push('mixer: with tails on, a 2 s reverb extends a 2 s export to ' + (r.buffer.length / SR).toFixed(2) + ' s');

    // Sends: a track sending to the reverb bus is louder than one that is not.
    const s = M.create('send');
    M.addSource(s, { id: 's1', duration: 2, channels: 1, sampleRate: SR });
    const ts = M.addTrack(s);
    M.addClip(s, ts, { sourceId: 's1', start: 0, duration: 0.5 });
    M.setSend(s, ts, 'bus-reverb', 0);
    r = await E.render(s, 0, 2, { sampleRate: SR, protect: false }); renders++;
    let tail = 0;
    const dd = r.buffer.getChannelData(0);
    for (let i = SR * 0.7; i < SR * 1.2; i++) tail = Math.max(tail, Math.abs(dd[i]));
    if (tail < 1e-3) fail('a send to the reverb bus left no tail');
    else notes.push('mixer: a send to the Reverb bus rings ' + db(tail).toFixed(1) + ' dB after the dry clip stops');
  }

  return { fails, notes, renders, plugins: D.ORDER.length, presets };
}
