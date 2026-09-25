#!/usr/bin/env node
/*
 * Checks that audio passes through the site without hidden quality loss,
 * and measures the numbers the pages quote. Runs in headless Chrome, since
 * decoding is the browser's.
 *
 *   decode   a 96 kHz / 24-bit WAV decodes at 96 kHz, every sample exact; a
 *            44.1 kHz file stays 44.1 kHz (it used to follow the device rate)
 *   PCM      WAV 24 and 16 of an unprocessed source are bit-exact copies;
 *            32-bit float round-trips exactly; "match source" keeps 24-bit
 *   dither   16-bit TPDF: a -90 dBFS tone shows no harmonics above the noise,
 *            where truncation would put them around -110 dB
 *   resample 96 -> 48, 96 -> 44.1, 44.1 <-> 48 are flat within 0.0001 dB to
 *            20 kHz, content above the new Nyquist folds back more than 120 dB
 *            down (140 for 30 kHz at 96 -> 48), and Chrome's own conversion
 *            is recorded for comparison (it passes that 30 kHz at full level)
 *   MP3      a 96 kHz source comes out at 48 kHz; 5.1 folds to stereo with the
 *            centre at -3 dB instead of losing it
 *   ffmpeg   FLAC 24 is bit-exact at 96 kHz, FLAC 16 is 16-bit, LAME V0 has
 *            a LAME header and full bandwidth, and M4A/OGG decode
 *
 * The ffmpeg core (30 MB) is taken from a local cache, downloaded once from
 * unpkg into ~/.cache/audiosaw/. Without it the ffmpeg section is skipped.
 *
 *   node tools/check-fidelity.js
 *
 * Needs Google Chrome. Skips (exit 0) when it cannot find it.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { findChrome, withPage } = require('./chrome-harness');

if (!findChrome()) {
  console.log('check-fidelity: skipped (no Chrome found; set CHROME=/path/to/chrome to run it).');
  process.exit(0);
}

const CORE_URL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.wasm';
const CORE_FILE = path.join(os.homedir(), '.cache', 'audiosaw', 'ffmpeg-core-0.12.6.wasm');

async function coreBytes() {
  if (fs.existsSync(CORE_FILE) && fs.statSync(CORE_FILE).size > 30e6) return fs.readFileSync(CORE_FILE);
  try {
    if (process.env.NO_CORE) return null;
    const res = await fetch(CORE_URL);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    fs.mkdirSync(path.dirname(CORE_FILE), { recursive: true });
    fs.writeFileSync(CORE_FILE, buf);
    return buf;
  } catch (e) { return null; }
}

/* ------------------------------------------------------------ fixtures */

// Interleaved integer PCM WAV. chans: arrays of integers at `bits`.
function wavInt(chans, rate, bits) {
  const nch = chans.length, len = chans[0].length, bps = bits / 8;
  const ext = nch > 2;
  const fmtSize = ext ? 40 : 16;
  const head = 12 + 8 + fmtSize + 8;
  const b = Buffer.alloc(head + len * nch * bps);
  b.write('RIFF', 0); b.writeUInt32LE(b.length - 8, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(fmtSize, 16);
  b.writeUInt16LE(ext ? 0xFFFE : 1, 20); b.writeUInt16LE(nch, 22); b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * nch * bps, 28); b.writeUInt16LE(nch * bps, 32); b.writeUInt16LE(bits, 34);
  if (ext) {
    b.writeUInt16LE(22, 36); b.writeUInt16LE(bits, 38); b.writeUInt32LE(0x3F, 40);
    Buffer.from('0100000000001000800000aa00389b71', 'hex').copy(b, 44);
  }
  b.write('data', head - 8); b.writeUInt32LE(len * nch * bps, head - 4);
  let o = head;
  for (let i = 0; i < len; i++) for (let c = 0; c < nch; c++) {
    const v = chans[c][i];
    if (bits === 16) b.writeInt16LE(v, o); else b.writeIntLE(v, o, 3);
    o += bps;
  }
  return b;
}

function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

// 1 s of 96 kHz / 24-bit stereo: a tone plus low-level noise, so every bit of
// the 24 is exercised.
function fixture96() {
  const n = 96000, r = rng(7), L = new Int32Array(n), R = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / 96000;
    L[i] = Math.round(0.4 * 8388607 * Math.sin(2 * Math.PI * 997 * t) + (r() - 0.5) * 2000);
    R[i] = Math.round(0.3 * 8388607 * Math.sin(2 * Math.PI * 30000 * t) + (r() - 0.5) * 2000);
  }
  return { wav: wavInt([L, R], 96000, 24), L, R };
}
function fixture44() {
  const n = 44100, r = rng(3), L = new Int32Array(n), R = new Int32Array(n);
  for (let i = 0; i < n; i++) { L[i] = Math.round((r() - 0.5) * 30000); R[i] = Math.round(0.5 * 32767 * Math.sin(2 * Math.PI * 440 * i / 44100)); }
  return { wav: wavInt([L, R], 44100, 16), L, R };
}
// 5.1 at 48 kHz / 24-bit: a 1 kHz tone at 0.5 in the centre only, 300 Hz in L only.
function fixture51() {
  const n = 48000, ch = [];
  for (let c = 0; c < 6; c++) ch.push(new Int32Array(n));
  for (let i = 0; i < n; i++) {
    ch[2][i] = Math.round(0.5 * 8388607 * Math.sin(2 * Math.PI * 1000 * i / 48000));
    ch[0][i] = Math.round(0.25 * 8388607 * Math.sin(2 * Math.PI * 300 * i / 48000));
  }
  return wavInt(ch, 48000, 24);
}

// 3 s of 96 kHz / 24-bit stereo for the page sweep: a sung-ish tone with
// vibrato and a gap of near-silence, so the silence tools have something to do
// and the pitch tools something to track. L and R differ, for the vocal remover.
function fixtureSweep() {
  const sr = 96000, n = sr * 3, L = new Int32Array(n), R = new Int32Array(n), r = rng(11);
  for (let i = 0; i < n; i++) {
    const t = i / sr, gap = t > 1.3 && t < 1.8;
    const f = 220 * Math.pow(2, 0.3 / 12 * Math.sin(2 * Math.PI * 5 * t));
    const v = gap ? 0 : 0.3 * Math.sin(2 * Math.PI * f * t) + 0.1 * Math.sin(4 * Math.PI * f * t);
    L[i] = Math.round((v + 0.05 * Math.sin(2 * Math.PI * 3000 * t) * !gap) * 8388607 + (r() - 0.5) * 40);
    R[i] = Math.round((v * 0.9) * 8388607 + (r() - 0.5) * 40);
  }
  return wavInt([L, R], sr, 24);
}
function flacOf(wav) {
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'as-fid-'));
    fs.writeFileSync(path.join(dir, 'a.wav'), wav);
    require('child_process').execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', path.join(dir, 'a.wav'), '-c:a', 'flac', path.join(dir, 'a.flac')]);
    const b = fs.readFileSync(path.join(dir, 'a.flac'));
    fs.rmSync(dir, { recursive: true, force: true });
    return b;
  } catch (e) { return null; }
}

// 1 s of a 19 kHz tone at 44.1 kHz / 16-bit: exported at 96 kHz, a poor
// conversion leaves an image at 44.1 - 19 = 25.1 kHz.
function fixture19k() {
  const n = 44100, L = new Int32Array(n);
  for (let i = 0; i < n; i++) L[i] = Math.round(0.5 * 32767 * Math.sin(2 * Math.PI * 19000 * i / 44100));
  return wavInt([L, L], 44100, 16);
}

const f96 = fixture96(), f44 = fixture44(), sweepWav = fixtureSweep(), sweepFlac = flacOf(sweepWav);

// Every tool page that writes audio, driven with the 96 kHz / 24-bit file and
// the WAV 24 choice. The output must keep 96 kHz, 24 bits and the channels
// (or what the tool is for: mono, 48 kHz). `set` runs before the click.
// Left out: /voice-recorder (a microphone), /stem-splitter (a 64 MB model;
// its rate handling is checked in the core section), /audio-editor (its own
// section), and pages locked to a preset (whisper, SP-404, Discord, podcast).
const SWEEP = [
  { page: '/noise-reduction' }, { page: '/audio-eq' }, { page: '/8d-audio' },
  { page: '/nightcore' }, { page: '/slowed-reverb' }, { page: '/vocal-remover' },
  { page: '/auto-cut-silence', sel: 'outFormat' }, { page: '/loudness-normalizer', sel: 'outFormat' },
  { page: '/autotune', sel: 'outFormat' }, { page: '/normalize-audio' }, { page: '/silence-remover' },
  { page: '/audio-reverser' }, { page: '/split-audio' },
  { page: '/audio-speed', set: 'document.getElementById("speed").value = "1.25"; document.getElementById("mode").value = "pitch-shift";' },
  { page: '/audio-speed', label: '/audio-speed (keep pitch)', ffmpeg: true, set: 'document.getElementById("speed").value = "1.25"; document.getElementById("mode").value = "pitch-preserve";' },
  { page: '/pitch-shifter', ffmpeg: true, set: 'document.getElementById("semitones").value = "2";' },
  { page: '/stereo-to-mono', ch: 1 },
  { page: '/change-sample-rate', sel: 'targetFormat', rate: 48000, set: 'document.getElementById("sampleRate").value = "48000";' },
  { page: '/mono-to-stereo', sel: 'targetFormat' }, { page: '/amplify-audio', sel: 'targetFormat' },
  { page: '/fade-in-fade-out', sel: 'targetFormat' }, { page: '/trim-silence-edges', sel: 'targetFormat' },
  { page: '/audio-cutter', btn: 'cutBtn', waitReady: '/^Loaded/.test(st())' },
  { page: '/audio-joiner', btn: 'joinBtn', twice: true, waitReady: '!btn.disabled && (window.__t0 = window.__t0 || Date.now(), Date.now() - window.__t0 > 3000)' },
  { page: '/', label: '/ (converter)', sel: 'targetFormat' },
  { page: '/flac-to-wav', flac: true, depth: '24' },
  { page: '/wav-to-flac', depth: '24', ffmpeg: true },
  { page: '/mp3-to-aiff', depth: '24', aiff: true },
  { page: '/davinci-resolve-audio', depth: '24', rate: 48000 },
  { page: '/wav-to-mp3', mp3: 'v0', ffmpeg: true, rate: 48000 }
];
const PAGE = `<!doctype html><meta charset="utf-8"><title>fidelity check</title>
<script src="/js/audio-core.js?v=check"></script>
<script>window.__run = ${pageTests.toString()};</script>`;

(async () => {
  const core = await coreBytes();
  let code = 1;
  try {
    await withPage({
      routes: {
        '/__fid': PAGE,
        '/__f96.wav': f96.wav,
        '/__f44.wav': f44.wav,
        '/__f51.wav': fixture51(),
        '/__core.wasm': () => core || Buffer.alloc(0),
        '/__sweep.wav': sweepWav,
        '/__t19k.wav': fixture19k(),
        '/__sweep.flac': sweepFlac || Buffer.alloc(0)
      }
    }, async (page) => {
      if (core) {
        // Serve the ffmpeg core from the local cache instead of unpkg.
        page.listen('Fetch.requestPaused', (p) => {
          page.send('Fetch.continueRequest', { requestId: p.requestId, url: page.url('/__core.wasm') });
        });
        await page.send('Fetch.enable', { patterns: [{ urlPattern: '*unpkg.com*ffmpeg-core.wasm*' }] });
      }
      await page.goto('/__fid');
      // FID_PAGES=/a,/b runs only those pages of the sweep, and skips the core section.
      const out = process.env.FID_PAGES ? { fails: [], notes: [], passed: 0 }
        : await page.eval('window.__run(' + JSON.stringify({ ffmpeg: !!core }) + ')', 600000);
      out.notes.forEach((n) => console.log('  ' + n));
      out.fails.forEach((f) => console.error('  FAIL ' + f));
      page.logs.forEach((l) => console.error('  ' + l));
      const ed = process.env.FID_SKIP_PAGES || process.env.FID_PAGES ? { fails: [], notes: [], passed: 0 } : await editorChecks(page);
      ed.notes.forEach((n) => console.log('  ' + n));
      ed.fails.forEach((f) => console.error('  FAIL ' + f));
      out.fails = out.fails.concat(ed.fails); out.passed += ed.passed;
      const sw = process.env.FID_SKIP_PAGES ? { fails: [], rows: [] } : await sweep(page, !!core);
      if (sw.rows.length) console.log('  pages: ' + sw.rows.join('; '));
      sw.fails.forEach((f) => console.error('  FAIL ' + f));
      const nf = out.fails.length + sw.fails.length;
      if (nf) console.error('check-fidelity: ' + nf + ' failure(s).');
      else { console.log('check-fidelity: ' + out.passed + ' fidelity claims hold, and ' + sw.rows.length + ' tool pages keep 96 kHz / 24-bit' + (core ? '' : ' (ffmpeg parts skipped: no core)') + '.'); code = 0; }
    });
  } catch (e) {
    console.error('check-fidelity: ' + (e.stack || e.message));
  }
  process.exit(code);
})();

/* ------------------------------------------------------------ the editor */

// The editor through its own UI: import, the export dialog, recording.
async function editorChecks(page) {
  const fails = [], notes = [];
  let passed = 0;
  const ok = (c, m) => { if (c) passed++; else fails.push(m); };
  async function fresh() {
    await page.goto('/audio-editor', 1500);
    await page.eval('new Promise((r) => { const q = indexedDB.deleteDatabase("audiosaw-editor"); q.onsuccess = q.onerror = q.onblocked = () => r(); })');
    await page.goto('/audio-editor', 1500);
  }
  // Import `url` as `name`, export with the given format/rate, return the file's header and samples.
  const exportOf = (url, name, fmt, rate) => page.eval(`(async () => {
    const wait = async (fn, ms) => { const end = Date.now() + (ms || 30000); while (!fn()) { if (Date.now() > end) throw new Error('timed out: ' + fn + ' / ' + document.getElementById('status').textContent); await new Promise((r) => setTimeout(r, 100)); } };
    const f = new File([await (await fetch(${JSON.stringify(url)})).arrayBuffer()], ${JSON.stringify(name)});
    const dt = new DataTransfer(); dt.items.add(f);
    const i = document.getElementById('fileInput'); i.files = dt.files; i.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(() => !document.getElementById('ed').classList.contains('is-empty'));
    await new Promise((r) => setTimeout(r, 500));
    let out = null;
    const orig = CV.downloadBlob;
    CV.downloadBlob = function (b, n) { out = { b, n }; };
    document.getElementById('edExport').click();
    document.getElementById('edExWhat').value = 'mix';
    document.getElementById('edExFmt').value = ${JSON.stringify(fmt)};
    document.getElementById('edExRate').value = ${JSON.stringify(String(rate))};
    document.getElementById('edExMono').checked = false;
    document.getElementById('edExGo').click();
    await wait(() => out, 120000);
    CV.downloadBlob = orig;
    const u = new Uint8Array(await out.b.arrayBuffer());
    const info = AudioSaw.sniffFormat(u);
    const ab = await AudioSaw.decodeToAudioBuffer(new File([u], 'x.wav'));
    return { info, sr: ab.sampleRate, L: Array.from(ab.getChannelData(0)) };
  })()`, 300000);
  const db = (x) => 20 * Math.log10(Math.max(1e-15, x));
  function amp(y, f, sr) {
    const a = Math.floor(y.length * 0.25), n = Math.floor(y.length * 0.5);
    let re = 0, im = 0, ws = 0;
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const w = 0.35875 - 0.48829 * Math.cos(2 * Math.PI * t) + 0.14128 * Math.cos(4 * Math.PI * t) - 0.01168 * Math.cos(6 * Math.PI * t);
      ws += w; const ph = 2 * Math.PI * f * (a + i) / sr;
      re += y[a + i] * w * Math.cos(ph); im += y[a + i] * w * Math.sin(ph);
    }
    return 2 * Math.hypot(re, im) / ws;
  }
  try {
    // 1. A 96 kHz / 24-bit clip exports at 96 kHz / 24-bit by default, and
    //    an untouched clip comes out sample for sample.
    await fresh();
    const a = await exportOf('/__f96.wav', 'hi.wav', 'wav24', 'project');
    ok(a.info && a.info.sampleRate === 96000 && a.info.bits === 24 && a.info.channels === 2, 'editor: 96k/24 clip exported as ' + JSON.stringify(a.info));
    let same = a.L.length >= f96.L.length;
    for (let i = 0; same && i < f96.L.length; i++) if (Math.round(a.L[i] * 8388608) !== f96.L[i]) same = false;
    ok(same, 'editor: an untouched 24-bit clip does not export bit-identical');
    notes.push('editor: a 96k/24 clip exports at 96k/24 by default' + (same ? ', bit-identical to the source' : ''));

    // 2. A 44.1 kHz clip exported at 96 kHz goes through the sinc resampler:
    //    no image of 19 kHz at 25.1 kHz.
    await fresh();
    const b = await exportOf('/__t19k.wav', 'cd.wav', 'wav32f', 96000);
    const img = db(amp(b.L, 25100, 96000) / 0.5), sig = db(amp(b.L, 19000, 96000) / 0.5);
    ok(b.sr === 96000 && Math.abs(sig) < 0.01 && img < -100, 'editor: 44.1k clip at 96k export: 19 kHz at ' + sig.toFixed(2) + ' dB, image at 25.1 kHz ' + img.toFixed(1) + ' dB');
    notes.push('editor: a 44.1k clip exported at 96k keeps 19 kHz at ' + sig.toFixed(3) + ' dB with its 25.1 kHz image at ' + img.toFixed(1) + ' dB');

    // 3. Recording: Chrome's defaults are a phone call's, what we ask for is not.
    await fresh();
    const r = await page.eval(`(async () => {
      const E = ASEditEngine;
      const plain = await navigator.mediaDevices.getUserMedia({ audio: true });
      const d0 = plain.getAudioTracks()[0].getSettings(); plain.getTracks().forEach((t) => t.stop());
      const c = E.micConstraints({}).audio;
      E.setSampleRate(96000); await E.unlock();
      const got = await E.startRecording(null, { channels: 2 });
      await new Promise((res) => setTimeout(res, 800));
      const res = await E.stopRecording();
      E.setSampleRate(null);
      return { d0: { ch: d0.channelCount, ec: d0.echoCancellation, ns: d0.noiseSuppression, agc: d0.autoGainControl },
        c: { ch: c.channelCount.ideal, ec: c.echoCancellation, ns: c.noiseSuppression, agc: c.autoGainControl },
        got, sr: res && res.buffer.sampleRate, len: res && res.buffer.length };
    })()`, 60000);
    ok(r.d0.ch === 1 && r.d0.ec && r.d0.ns && r.d0.agc, 'Chrome\'s default microphone is no longer mono with processing on (' + JSON.stringify(r.d0) + '); the editor page says it is');
    ok(r.c.ch === 2 && r.c.ec === false && r.c.ns === false && r.c.agc === false, 'editor: microphone constraints ' + JSON.stringify(r.c));
    ok(r.got && r.got.channels === 2 && !r.got.processing, 'editor: the browser delivered ' + JSON.stringify(r.got));
    ok(r.sr === 96000 && r.len > 96000 * 0.3, 'editor: a take with the engine at 96 kHz came back at ' + r.sr + ' Hz, ' + r.len + ' samples');
    // 4. /voice-recorder: studio mode keeps float samples; voice mode still works.
    await page.goto('/voice-recorder', 1200);
    const vr = await page.eval(`(async () => {
      const wait = async (fn, ms) => { const e = Date.now() + (ms || 15000); while (!fn()) { if (Date.now() > e) throw new Error('timeout ' + fn + ' ' + document.getElementById('status').textContent); await new Promise((r) => setTimeout(r, 100)); } };
      const res = {};
      for (const q of ['studio', 'clean']) {
        document.getElementById('resetBtn').click();
        const s = document.getElementById('cleanup'); s.value = q; s.dispatchEvent(new Event('change'));
        document.getElementById('recordBtn').click();
        await wait(() => !document.getElementById('stopBtn').disabled);
        await new Promise((r) => setTimeout(r, 1200));
        document.getElementById('stopBtn').click();
        await wait(() => document.getElementById('controls').style.display === '');
        let out = null; const o = CV.downloadBlob; CV.downloadBlob = function (b, n) { out = { b, n }; };
        document.getElementById('outFmt').value = 'wav'; document.getElementById('saveBtn').click();
        await wait(() => out, 30000); CV.downloadBlob = o;
        res[q] = AudioSaw.sniffFormat(new Uint8Array(await out.b.arrayBuffer()));
      }
      return res;
    })()`, 90000);
    ok(vr.studio && vr.studio.float && vr.studio.bits === 32, '/voice-recorder studio take saved as ' + JSON.stringify(vr.studio) + ' (want 32-bit float for "match the source")');
    ok(vr.clean && vr.clean.bits === 16, '/voice-recorder voice take saved as ' + JSON.stringify(vr.clean));
    notes.push('/voice-recorder: studio saves the float capture at ' + (vr.studio.sampleRate / 1000) + ' kHz; voice mode decodes and writes ' + vr.clean.bits + '-bit');
    notes.push('editor: Chrome\'s default mic is mono with echo cancellation, noise suppression and AGC on; the editor asks for and gets stereo with all three off, and records at the engine rate (96 kHz here)');
  } catch (e) {
    fails.push('editor: ' + String(e.message || e).split('\n')[0].slice(0, 300));
  }
  return { fails, notes, passed };
}

/* ------------------------------------------------------ the page sweep */

async function sweep(page, haveCore) {
  const fails = [], rows = [];
  await page.send('Network.enable');
  await page.send('Network.setBlockedURLs', { urls: ['*googletagmanager*', '*google-analytics*', '*fonts.googleapis*', '*fonts.gstatic*'] });
  const only = process.env.FID_PAGES ? process.env.FID_PAGES.split(',') : null;
  for (const t of SWEEP) {
    const label = t.label || t.page;
    if (only && only.indexOf(t.page) < 0) continue;
    if (t.ffmpeg && !haveCore) continue;
    if (t.flac && !sweepFlac) { rows.push(label + ' skipped (no local ffmpeg for the FLAC fixture)'); continue; }
    try {
      await page.goto(t.page, 1200);
      const src = t.flac ? '/__sweep.flac' : '/__sweep.wav', name = t.flac ? 'sweep.flac' : 'sweep.wav';
      const got = await page.eval(`(async () => {
        const st = () => ((document.getElementById('status') || {}).textContent || '').trim().slice(0, 160);
        const wait = async (fn, ms) => { const end = Date.now() + (ms || 20000); while (!fn()) { if (Date.now() > end) throw new Error('timed out waiting for ' + fn + ' (status: ' + st() + ')'); await new Promise((r) => setTimeout(r, 100)); } };
        let out = null;
        const orig = CV.downloadBlob;
        CV.downloadBlob = function (b, n, o) { out = { b, n }; return orig.apply(this, arguments); };
        const file = new File([await (await fetch(${JSON.stringify(src)})).arrayBuffer()], ${JSON.stringify(name)});
        const dt = new DataTransfer(); dt.items.add(file); ${t.twice ? 'dt.items.add(new File([file], "sweep2.wav"));' : ''}
        const input = document.getElementById('fileInput');
        input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true }));
        const btn = document.getElementById(${JSON.stringify(t.btn || 'convertBtn')});
        await wait(() => ${t.waitReady || '!btn.disabled'});
        ${t.sel !== false && !t.depth && !t.mp3 ? `{ const s = document.getElementById(${JSON.stringify(t.sel || 'outFmt')}); s.value = 'wav24'; s.dispatchEvent(new Event('change', { bubbles: true })); }` : ''}
        ${t.depth ? `document.getElementById('depth').value = ${JSON.stringify(t.depth)};` : ''}
        ${t.mp3 ? `document.getElementById('bitrate').value = ${JSON.stringify(t.mp3)};` : ''}
        ${t.set || ''}
        btn.click();
        await wait(() => out || document.querySelector('#status.error'), 120000);
        if (!out) throw new Error('no output (status: ' + st() + ')');
        let u = new Uint8Array(await out.b.arrayBuffer());
        if (/\.zip$/i.test(out.n)) {                 // first entry of a STORE zip
          const dv = new DataView(u.buffer), nl = dv.getUint16(26, true), size = dv.getUint32(18, true);
          u = u.subarray(30 + nl, 30 + nl + size);
        }
        const info = AudioSaw.sniffFormat(u);
        const status = (document.getElementById('status') || {}).textContent || '';
        return { name: out.n, info, status };
      })()`, 300000);
      const i = got.info || {};
      const wantRate = t.rate || 96000, wantCh = t.ch || 2, wantBits = t.mp3 ? 0 : 24;
      const bad = [];
      if (i.sampleRate !== wantRate) bad.push(i.sampleRate + ' Hz');
      if ((i.channels || 0) !== wantCh) bad.push(i.channels + ' ch');
      if (!t.mp3 && i.bits !== wantBits) bad.push(i.bits + '-bit');
      if (t.aiff && i.container !== 'aiff') bad.push(i.container);
      if (t.page === '/wav-to-flac' && i.container !== 'flac') bad.push(i.container);
      if (bad.length) fails.push(label + ': wrote ' + bad.join(', ') + ' (' + got.name + ')');
      else rows.push(label + ' ' + (i.sampleRate / 1000) + 'k/' + (i.bits || i.codec) + '/' + i.channels + 'ch');
    } catch (e) {
      fails.push(label + ': ' + String(e.message || e).split('\n')[0].slice(0, 300) + (page.logs.length ? ' | ' + page.logs.slice(-3).join(' | ') : ''));
    }
  }
  return { fails, rows };
}

/* -------------------------------------------------- runs in the page */

async function pageTests(cfg) {
  const A = window.AudioSaw, fails = [], notes = [];
  let passed = 0;
  const ok = (cond, msg) => { if (cond) passed++; else fails.push(msg); return cond; };
  const db = (x) => 20 * Math.log10(Math.max(1e-15, x));
  const f1 = (x) => (Math.round(x * 10) / 10).toFixed(1);
  const fetchFile = async (url, name) => new File([await (await fetch(url)).arrayBuffer()], name);
  const decodeBlob = (blob, name) => A.decodeToAudioBuffer(new File([blob], name || 'x'));

  // Amplitude of frequency f, single-bin DFT under a Blackman-Harris window
  // over the middle half.
  function amp(y, f, sr) {
    const a = Math.floor(y.length * 0.25), n = Math.floor(y.length * 0.5);
    let re = 0, im = 0, ws = 0;
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const w = 0.35875 - 0.48829 * Math.cos(2 * Math.PI * t) + 0.14128 * Math.cos(4 * Math.PI * t) - 0.01168 * Math.cos(6 * Math.PI * t);
      ws += w;
      const ph = 2 * Math.PI * f * (a + i) / sr;
      re += y[a + i] * w * Math.cos(ph); im += y[a + i] * w * Math.sin(ph);
    }
    return 2 * Math.hypot(re, im) / ws;
  }
  function tone(f, sr, n, g) {
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = (g || 0.5) * Math.sin(2 * Math.PI * f * i / sr);
    return x;
  }
  async function bytes(blob) { return new Uint8Array(await blob.arrayBuffer()); }
  function dataOf(u8) {   // the data chunk of a WAV
    const v = new DataView(u8.buffer, u8.byteOffset);
    for (let o = 12; o + 8 <= u8.length;) {
      const id = String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]), sz = v.getUint32(o + 4, true);
      if (id === 'data') return u8.subarray(o + 8, o + 8 + sz);
      o += 8 + sz + (sz & 1);
    }
    return null;
  }
  function same(a, b) { if (!a || !b || a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; }

  /* ---- decode at the file's own rate */
  const w96 = await fetchFile('/__f96.wav', 'hi.wav');
  const ab96 = await A.decodeToAudioBuffer(w96);
  ok(ab96.sampleRate === 96000, 'decode: 96 kHz WAV came back at ' + ab96.sampleRate);
  ok(ab96.numberOfChannels === 2, 'decode: 96 kHz WAV has ' + ab96.numberOfChannels + ' channels');
  let off = 0;
  const d0 = ab96.getChannelData(0);
  for (let i = 0; i < d0.length; i++) { const v = d0[i] * 8388608; off = Math.max(off, Math.abs(v - Math.round(v))); }
  ok(off === 0, 'decode: 24-bit samples not exact (max ' + off + ' LSB off the grid)');
  ok(ab96.srcInfo && ab96.srcInfo.bits === 24 && ab96.srcInfo.lossless, 'decode: srcInfo missing 24-bit lossless');
  const w44 = await fetchFile('/__f44.wav', 'cd.wav');
  const ab44 = await A.decodeToAudioBuffer(w44);
  ok(ab44.sampleRate === 44100, 'decode: 44.1 kHz WAV came back at ' + ab44.sampleRate);
  notes.push('decode: 96k/24 and 44.1k/16 decode at their own rates, sample-exact (device rate here ' + new AudioContext().sampleRate + ')');

  /* ---- PCM writers */
  const src96 = dataOf(await bytes(w96)), src44 = dataOf(await bytes(w44));
  ok(same(dataOf(await bytes(await A.encode(ab96, 'wav24'))), src96), 'wav24 of a 24-bit source is not bit-exact');
  ok(same(dataOf(await bytes(await A.encode(ab96, 'wav'))), src96), 'wav (match source) of a 24-bit source is not the 24-bit original');
  ok(same(dataOf(await bytes(await A.encode(ab44, 'wav16'))), src44), 'wav16 of a 16-bit source is not bit-exact');
  ok(same(dataOf(await bytes(await A.encode(ab44, 'wav'))), src44), 'wav (match source) of a 16-bit source is not bit-exact');
  const aiff = await bytes(await A.encode(ab96, 'aiff24'));
  const aiffBack = await decodeBlob(new Blob([aiff]), 'x.aiff').catch(() => null);
  if (aiffBack) {
    const same24 = aiffBack.sampleRate === 96000 && aiffBack.getChannelData(0).every((v, i) => v === d0[i]);
    ok(same24, 'aiff24 does not decode back exactly');
  } else notes.push('aiff: this browser does not decode AIFF; writer checked by header only');
  const aInfo = A.sniffFormat(aiff);
  ok(aInfo && aInfo.sampleRate === 96000 && aInfo.bits === 24 && aInfo.channels === 2, 'aiff24 header wrong: ' + JSON.stringify(aInfo));

  // Float: a processed signal (not on any integer grid) survives exactly.
  const proc = A.makeBuffer([tone(1234.5, 96000, 9600, 0.7071).map((v) => v * 1.0001)], 96000);
  const fb = await decodeBlob(await A.encode(proc, 'wav32f'), 'f.wav');
  ok(fb.sampleRate === 96000 && fb.getChannelData(0).every((v, i) => v === proc.getChannelData(0)[i]), 'wav32f does not round-trip exactly');
  notes.push('pcm: WAV 16/24 and AIFF 24 are bit-exact copies of an unprocessed source; 32-bit float round-trips exactly');

  /* ---- dither */
  {
    const sr = 48000, n = sr * 4, lvl = Math.pow(10, -90 / 20);
    const x = A.makeBuffer([tone(1000, sr, n, lvl)], sr);
    const withD = (await decodeBlob(await A.encode(x, 'wav16'), 'd.wav')).getChannelData(0);
    const noD = (await decodeBlob(await A.encode(x, 'wav16', { dither: false }), 'n.wav')).getChannelData(0);
    const harm = (y) => Math.max(...[3000, 5000, 7000].map((f) => amp(y, f, sr)));
    const hD = db(harm(withD)), hN = db(harm(noD));
    ok(hD < -130, 'dither: harmonics of a -90 dBFS tone at ' + f1(hD) + ' dBFS (want < -130)');
    ok(hN > hD + 10, 'dither: undithered truncation should be clearly worse, got ' + f1(hN) + ' vs ' + f1(hD));
    let e = 0; const xs = x.getChannelData(0);
    for (let i = 0; i < n; i++) e += (withD[i] - xs[i]) ** 2;
    const floor = db(Math.sqrt(e / n));
    ok(floor > -97.5 && floor < -95, 'dither: 16-bit TPDF noise at ' + f1(floor) + ' dBFS (want about -96.3)');
    notes.push('dither: -90 dBFS tone at 16-bit: odd harmonics ' + f1(hD) + ' dBFS with TPDF, ' + f1(hN) + ' dBFS truncated; noise floor ' + f1(floor) + ' dBFS');
  }

  /* ---- resampler */
  {
    const R = await A.ensureResampler();
    const rows = [];
    for (const [a, b] of [[96000, 48000], [96000, 44100], [44100, 48000], [48000, 44100]]) {
      let worst = 0;
      for (const f of [100, 1000, 10000, 15000, 19000, 20000]) {
        const y = R.channel(tone(f, a, a), a, b);
        worst = Math.max(worst, Math.abs(db(amp(y, f, b) / 0.5)));
      }
      // /change-sample-rate quotes "flat within 0.0001 dB to 20 kHz".
      ok(worst < 0.0001, 'resample ' + a + '->' + b + ': passband off by ' + worst.toFixed(5) + ' dB by 20 kHz');
      let alias = null;
      if (b < a) {
        const f = Math.round((a / 2 + b / 2) / 2), fa = b - f;   // mid-way between the two Nyquists
        const y = R.channel(tone(f, a, a), a, b);
        alias = db(amp(y, fa, b) / 0.5);
        // Quoted: aliasing more than 120 dB down; 30 kHz from 96 -> 48 more than 140 dB down.
        ok(alias < (a === 96000 && b === 48000 ? -140 : -120), 'resample ' + a + '->' + b + ': ' + f + ' Hz folds to ' + fa + ' Hz at ' + f1(alias) + ' dB');
      }
      rows.push(a / 1000 + '->' + b / 1000 + ' flat ±' + worst.toFixed(6) + ' dB to 20k' + (alias != null ? ', alias ' + f1(alias) + ' dB' : ''));
    }
    // For the record: what Web Audio's own conversion does to the same alias test.
    const src = A.makeBuffer([tone(30000, 96000, 96000)], 96000);
    const O = new OfflineAudioContext(1, 48000, 48000), bs = O.createBufferSource();
    bs.buffer = src; bs.connect(O.destination); bs.start();
    const wa = (await O.startRendering()).getChannelData(0);
    rows.push('Web Audio for comparison: 30 kHz folds to 18 kHz at ' + f1(db(amp(wa, 18000, 48000) / 0.5)) + ' dB, 19 kHz at ' +
      f1(db(amp(await (async () => { const O2 = new OfflineAudioContext(1, 48000, 48000), b2 = O2.createBufferSource(); b2.buffer = A.makeBuffer([tone(19000, 96000, 96000)], 96000); b2.connect(O2.destination); b2.start(); return (await O2.startRendering()).getChannelData(0); })(), 19000, 48000) / 0.5)) + ' dB');
    const waAlias = db(amp(wa, 18000, 48000) / 0.5);
    ok(waAlias > -1, 'Chrome\'s own 96 -> 48 conversion no longer passes 30 kHz at full level (' + f1(waAlias) + ' dB); /change-sample-rate says it does');
    notes.push('resample: ' + rows.join('; '));
    // The whole buffer path, including channel count.
    const rb = await A.resampleBuffer(ab96, 48000);
    ok(rb.sampleRate === 48000 && rb.numberOfChannels === 2 && Math.abs(rb.length - 48000) <= 1, 'resampleBuffer 96k -> 48k gave ' + rb.sampleRate + '/' + rb.numberOfChannels + '/' + rb.length);
  }

  /* ---- MP3 via lamejs */
  {
    const mp3 = await A.encode(ab96, 'mp3', { bitrate: 320 });
    const info = A.sniffFormat(await bytes(mp3));
    ok(info && info.sampleRate === 48000, 'mp3 of a 96 kHz source: ' + JSON.stringify(info));
    const w51 = await fetchFile('/__f51.wav', 'surround.wav');
    const ab51 = await A.decodeToAudioBuffer(w51);
    ok(ab51.numberOfChannels === 6, '5.1 WAV decoded to ' + ab51.numberOfChannels + ' channels');
    const st = A.downmixStereo(ab51);
    const cL = db(amp(st.getChannelData(0), 1000, 48000) / 0.5), cR = db(amp(st.getChannelData(1), 1000, 48000) / 0.5);
    const lL = db(amp(st.getChannelData(0), 300, 48000) / 0.25), lR = db(amp(st.getChannelData(1), 300, 48000) / 0.25);
    ok(Math.abs(cL + 3.01) < 0.05 && Math.abs(cR + 3.01) < 0.05, '5.1 downmix: centre at ' + f1(cL) + '/' + f1(cR) + ' dB (want -3.0)');
    ok(Math.abs(lL) < 0.05 && lR < -100, '5.1 downmix: front left gave L ' + f1(lL) + ' R ' + f1(lR) + ' dB');
    const back = await decodeBlob(await A.encode(ab51, 'mp3', { bitrate: 320 }), 's.mp3');
    const mc = db(amp(back.getChannelData(0), 1000, back.sampleRate) / 0.5);
    ok(back.numberOfChannels === 2 && Math.abs(mc + 3) < 0.5, '5.1 to MP3: centre at ' + f1(mc) + ' dB in ' + back.numberOfChannels + ' ch');
    notes.push('mp3: 96 kHz source written at 48 kHz; 5.1 folds with the centre at ' + f1(cL) + ' dB each side (' + f1(mc) + ' dB after MP3)');
  }

  /* ---- ffmpeg: FLAC, LAME, lossy */
  if (cfg.ffmpeg) {
    const flac24 = await A.encode(ab96, 'flac24');
    const fi = A.sniffFormat(await bytes(flac24));
    ok(fi && fi.bits === 24 && fi.sampleRate === 96000, 'flac24 header: ' + JSON.stringify(fi));
    const fback = await decodeBlob(flac24, 'x.flac');
    ok(fback.sampleRate === 96000 && fback.getChannelData(0).every((v, i) => v === d0[i]) &&
      fback.getChannelData(1).every((v, i) => v === ab96.getChannelData(1)[i]), 'flac24 is not bit-exact');
    const flacM = A.sniffFormat(await bytes(await A.encode(ab96, 'flac')));
    ok(flacM && flacM.bits === 24, 'flac (match source) of 24-bit wrote ' + (flacM && flacM.bits) + '-bit');
    const f16 = await A.encode(ab96, 'flac16');
    const f16i = A.sniffFormat(await bytes(f16));
    ok(f16i && f16i.bits === 16, 'flac16 header says ' + (f16i && f16i.bits) + '-bit');
    const f16b = (await decodeBlob(f16, 'y.flac')).getChannelData(0);
    // Chrome decodes 16-bit as positive / 32767, negative / 32768.
    const on16 = (v) => { const w = v > 0 ? v * 32767 : v * 32768; return Math.abs(w - Math.round(w)) < 1e-3 || v * 32768 === Math.round(v * 32768); };
    ok(f16b.every(on16), 'flac16 samples are not on the 16-bit grid');
    notes.push('flac: FLAC 24 of a 96k/24 source is bit-exact; FLAC 16 is dithered 16-bit; sizes ' +
      Math.round(flac24.size / 1024) + ' KB vs WAV ' + Math.round(f96Size() / 1024) + ' KB');

    // LAME V0 on noise at 44.1 kHz: header and bandwidth.
    const n = 44100 * 3, r = (() => { let s = 5; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296 * 2 - 1; }; })();
    const nz = new Float32Array(n), nz2 = new Float32Array(n);
    for (let i = 0; i < n; i++) { nz[i] = 0.2 * r(); nz2[i] = 0.2 * r(); }
    const noise = A.makeBuffer([nz, nz2], 44100);
    const v0 = await A.encode(noise, 'mp3-v0');
    const head = new TextDecoder('latin1').decode((await bytes(v0)).subarray(0, 4096));
    // ffmpeg's LAME tag names the encoder "Lavc", not "LAME"; the tag is what
    // carries the encoder delay and padding for gapless playback.
    ok(/(Xing|Info)[\s\S]*(LAME|Lavc)/.test(head), 'mp3-v0 has no Xing/LAME header');
    // Level at 18.6-19.2 kHz relative to 4-6 kHz, output over input.
    const bandOf = (b) => {
      const e = (f0, f1_) => { let s = 0, k = 0; for (let f = f0; f <= f1_; f += 97) { s += amp(b, f, 44100) ** 2; k++; } return s / k; };
      return 10 * Math.log10(e(18600, 19200) / e(4000, 6000));
    };
    const ref = bandOf(nz);
    const band = async (blob, name) => bandOf((await decodeBlob(blob, name)).getChannelData(0)) - ref;
    const bwV0 = await band(v0, 'v0.mp3');
    const bwJs = await band(await A.encode(noise, 'mp3', { bitrate: 320 }), 'js.mp3');
    ok(bwV0 > -3, 'mp3-v0: 18.6-19.2 kHz sits ' + f1(bwV0) + ' dB below 4-6 kHz (want > -3)');
    const hi = await decodeBlob(await A.encode(ab96, 'mp3-v0'), 'hi.mp3');
    ok(hi.sampleRate === 48000, 'mp3-v0 of a 96 kHz source decoded at ' + hi.sampleRate);
    notes.push('mp3: LAME V0 ' + Math.round(v0.size * 8 / 3 / 1000) + ' kbps on noise, LAME header present; 18.6-19.2 kHz vs 4-6 kHz: V0 ' + f1(bwV0) + ' dB, lamejs 320 ' + f1(bwJs) + ' dB');

    for (const [fmt, rate] of [['m4a', 96000], ['ogg', 96000]]) {
      const b = await A.encode(ab96, fmt, { bitrate: 256 }).catch((e) => { fails.push(fmt + ': ' + e.message); return null; });
      if (!b) continue;
      const back2 = await decodeBlob(b, 'z.' + fmt).catch(() => null);
      ok(back2 && back2.numberOfChannels === 2 && back2.sampleRate === rate, fmt + ' of 96k stereo decoded as ' + (back2 && back2.sampleRate + '/' + back2.numberOfChannels));
    }

    // convert(): the converter pages' entry point, match-source tokens.
    const cf = A.sniffFormat(await bytes(await A.convert(w96, 'flac')));
    ok(cf && cf.bits === 24 && cf.sampleRate === 96000, 'convert(96k/24 wav -> flac) gave ' + JSON.stringify(cf));
    const cw = A.sniffFormat(await bytes(await A.convert(await fetchFile('/__f96.wav', 'hi.flac').then(() => new File([flac24], 'hi.flac')), 'wav')));
    ok(cw && cw.bits === 24 && cw.sampleRate === 96000, 'convert(flac24 -> wav) gave ' + JSON.stringify(cw));
    notes.push('convert: WAV <-> FLAC keeps 96 kHz / 24-bit; M4A and OGG of 96k stereo decode at 96k stereo');
  }

  function f96Size() { return 96000 * 2 * 3; }
  return { fails, notes, passed };
}
