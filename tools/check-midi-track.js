#!/usr/bin/env node
/*
 * Checks MIDI in /audio-editor, in headless Chrome, driving the real page:
 *
 *   1. a .mid file (written by midi-write.js at 100 BPM, one octave of C
 *      major) opens as a MIDI track, and an empty project takes its tempo
 *   2. the export of it sounds every note at its pitch (within 1%) and at its
 *      time, at a sane level, with the notes drawn on the clip
 *   3. every instrument sounds at the note's pitch, and the drum kit puts a
 *      kick low and a hi-hat high
 *   4. autosave and a project file keep the notes, with no audio stored
 *   5. Bounce to audio (clip menu) replaces the notes with the same sound,
 *      and undo brings the notes back
 *   6. Convert to MIDI (clip menu) turns a sung-like melody into notes on a
 *      new track under it, at the right pitches
 *   7. the note editor opens on the clip, plays its notes, and saving writes a
 *      new source
 *   8. a dense minute of notes exports faster than real time
 *
 *   node tools/check-midi-track.js
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
  console.log('check-midi-track: skipped (no Chrome found; set CHROME=/path/to/chrome to run it).');
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'as-midi-'));
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
      source: 'try { Object.defineProperty(navigator, "serviceWorker", { value: undefined }); } catch (e) {} window.__errs = []; addEventListener("error", function (e) { window.__errs.push(String(e.message)); }); addEventListener("unhandledrejection", function (e) { window.__errs.push(String(e.reason && e.reason.message || e.reason)); });'
    });
    const r = makeRunner(cdp, origin);
    await scenario(r, cdp);
    if (fails.length) {
      fails.forEach((f) => console.error('  FAIL ' + f));
      console.error('check-midi-track: ' + fails.length + ' failure(s).');
    } else {
      notes.forEach((n) => console.log('  ' + n));
      console.log('check-midi-track: .mid import, every instrument at pitch, export, autosave and project files, bounce with undo, audio to MIDI, and the note editor.');
      code = 0;
    }
    cdp.close();
  } catch (e) {
    fails.forEach((f) => console.error('  FAIL ' + f));
    console.error('check-midi-track: ' + (e.stack || e.message));
  }
  chrome.kill();
  server.close();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  process.exit(code);
});


/* ------------------------------------------------------------ scenario */

// Page-side helpers: the strongest pitch in a window (autocorrelation with
// parabolic refinement), and the RMS level, of a rendered buffer.
const HELPERS = `window.__pitch = function (d, sr, t0, t1) {
  var a = Math.round(t0 * sr), n = Math.min(Math.round((t1 - t0) * sr), 8192), best = 0, bl = 0, r0 = 0;
  for (var i = 0; i < n; i++) r0 += d[a + i] * d[a + i];
  var prevR = 1, dip = false;
  for (var lag = Math.round(sr / 2000); lag < Math.round(sr / 40); lag++) {
    var r = 0; for (var j = 0; j + lag < n; j++) r += d[a + j] * d[a + j + lag];
    r /= r0 || 1;
    if (r < 0.2) dip = true;
    if (dip && r > best) { best = r; bl = lag; }
    if (dip && best > 0.6 && r < best - 0.2) break;
  }
  if (!bl) return 0;
  var f = function (L) { var r = 0; for (var j = 0; j + L < n; j++) r += d[a + j] * d[a + j + L]; return r; };
  var y0 = f(bl - 1), y1 = f(bl), y2 = f(bl + 1), den = y0 - 2 * y1 + y2, sh = den ? 0.5 * (y0 - y2) / den : 0;
  return sr / (bl + sh);
};
window.__rms = function (d, sr, t0, t1) { var a = Math.round(t0 * sr), b = Math.round(t1 * sr), s = 0; for (var i = a; i < b; i++) s += d[i] * d[i]; return Math.sqrt(s / Math.max(1, b - a)); };
window.__band = function (d, sr, t0, len, lo, hi) {
  // Energy share between lo and hi Hz, by a plain DFT on 2048 samples.
  var a = Math.round(t0 * sr), N = 2048, tot = 0, inb = 0;
  for (var k = 1; k < N / 2; k++) {
    var re = 0, im = 0, w = 2 * Math.PI * k / N;
    for (var i = 0; i < N; i++) { var v = d[a + i] || 0; re += v * Math.cos(w * i); im -= v * Math.sin(w * i); }
    var e = re * re + im * im, hz = k * sr / N; tot += e; if (hz >= lo && hz < hi) inb += e;
  }
  return tot ? inb / tot : 0;
};`;

async function scenario(r, cdp) {
  await r.open('/audio-editor');
  await r.waitFor('!!window.ASEditMidi && !!window.ASMidi && !!document.getElementById("fileInput")');
  await r.eval(HELPERS);

  // 1. Import: C D E F G A B C at 100 BPM, one per beat (0.6 s), 0.5 s long.
  const SCALE = [60, 62, 64, 65, 67, 69, 71, 72];
  await r.eval(`(function () {
    var notes = ${JSON.stringify(SCALE)}.map(function (m, k) { return { midi: m, start: k * 0.6, duration: 0.5, velocity: 100 }; });
    var bytes = ASMidi.build(notes, { bpm: 100, trackName: 'Scale' });
    var dt = new DataTransfer(); dt.items.add(new File([bytes], 'scale.mid', { type: 'audio/midi' }));
    var i = document.getElementById('fileInput'); i.files = dt.files; i.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await r.waitSaved();
  let p = await r.project();
  const t0 = p.tracks[0], c0 = t0 && t0.clips[0], s0 = c0 && p.sources[c0.sourceId];
  ok(p.tracks.length === 1 && s0 && s0.kind === 'midi' && s0.notes.length === 8, 'the .mid opens as one MIDI track with its 8 notes (' + (s0 && s0.notes.length) + ')');
  ok(Math.abs(p.bpm - 100) < 0.01, 'an empty project takes the file’s tempo (' + p.bpm + ' BPM)');
  ok(t0 && t0.inst === 'keys', 'a part with no program plays on the keys (' + (t0 && t0.inst) + ')');
  notes.push('imported ' + (s0 && s0.notes.length) + ' notes at ' + p.bpm + ' BPM');

  // Live playback over the MIDI track; errors are collected for the end.
  // A real click first: an AudioContext only runs after a user gesture, and
  // a script's click() is not one.
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 4, y: 4, button: 'left', buttons: 1, clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 4, y: 4, button: 'left', buttons: 0, clickCount: 1 });
  await r.eval('document.getElementById("edPlay").click()');
  await sleep(700);
  const live = await r.eval('ASEditEngine.isPlaying() && ASEditEngine.position() > 0.2');
  await r.eval('document.getElementById("edPlay").click()');
  ok(live, 'the MIDI track plays live');

  // 2. The export sounds every note at its pitch and time.
  const scan = await r.eval(`ASEditEngine.render(${JSON.stringify(p)}, 0, 5, { sampleRate: 44100, channels: 2 }).then(function (res) {
    var d = res.buffer.getChannelData(0), sr = 44100, out = [];
    for (var k = 0; k < 8; k++) out.push({ hz: __pitch(d, sr, k * 0.6 + 0.1, k * 0.6 + 0.3), rms: __rms(d, sr, k * 0.6 + 0.05, k * 0.6 + 0.45) });
    return { notes: out, peak: res.peak, before: __rms(d, sr, 4.95, 5) };
  })`);
  let worstCents = 0;
  scan.notes.forEach((n, k) => { const want = 440 * Math.pow(2, (SCALE[k] - 69) / 12); worstCents = Math.max(worstCents, Math.abs(1200 * Math.log2(n.hz / want))); });
  ok(worstCents < 17, 'every exported note is at its pitch (worst ' + worstCents.toFixed(1) + ' cents)');
  ok(scan.notes.every((n) => n.rms > 0.01), 'every note sounds');
  ok(scan.peak > 0.05 && scan.peak < 0.9, 'a sane level: peak ' + (20 * Math.log10(scan.peak)).toFixed(1) + ' dBFS');
  notes.push('export: worst pitch error ' + worstCents.toFixed(1) + ' cents, peak ' + (20 * Math.log10(scan.peak)).toFixed(1) + ' dBFS');

  // 3. Every instrument at A4, and the drum kit.
  const inst = await r.eval(`(function () {
    var out = {}, ids = ASEditSynth.INSTRUMENTS.map(function (x) { return x.id; }).filter(function (x) { return x !== 'drums'; });
    var chain = Promise.resolve();
    ids.forEach(function (id) {
      chain = chain.then(function () {
        var p = ASEditModel.create('i'), t = ASEditModel.addTrack(p);
        ASEditModel.setTrack(p, t, { inst: id });
        var s = ASEditModel.addSource(p, { kind: 'midi', name: 'a', notes: [{ midi: 69, start: 0, duration: 1, velocity: 100 }] });
        ASEditModel.addClip(p, t, { sourceId: s, start: 0 });
        return ASEditEngine.render(p, 0, 1.2, { sampleRate: 44100, channels: 1 }).then(function (res) {
          var d = res.buffer.getChannelData(0);
          out[id] = { hz: __pitch(d, 44100, 0.3, 0.5), rms: __rms(d, 44100, 0.1, 0.9) };
        });
      });
    });
    return chain.then(function () {
      var p = ASEditModel.create('d'), t = ASEditModel.addTrack(p);
      ASEditModel.setTrack(p, t, { inst: 'drums' });
      var s = ASEditModel.addSource(p, { kind: 'midi', name: 'kit', drums: true, notes: [{ midi: 36, start: 0, duration: 0.2, velocity: 110 }, { midi: 42, start: 1, duration: 0.1, velocity: 110 }] });
      ASEditModel.addClip(p, t, { sourceId: s, start: 0 });
      return ASEditEngine.render(p, 0, 1.5, { sampleRate: 44100, channels: 1 });
    }).then(function (res) {
      var d = res.buffer.getChannelData(0);
      out.kickLow = __band(d, 44100, 0.005, 2048, 20, 200);
      out.hatHigh = __band(d, 44100, 1.001, 2048, 5000, 22050);
      return out;
    });
  })()`);
  const bad = Object.keys(inst).filter((k) => inst[k].hz !== undefined && (Math.abs(1200 * Math.log2(inst[k].hz / 440)) > 17 || inst[k].rms < 0.005));
  ok(!bad.length, 'every instrument plays A4 at 440 Hz (' + Object.keys(inst).filter((k) => inst[k].hz).map((k) => k + ' ' + inst[k].hz.toFixed(1)).join(', ') + ')');
  ok(inst.kickLow > 0.7 && inst.hatHigh > 0.7, 'the drum kit puts the kick low and the hi-hat high (' + (inst.kickLow * 100).toFixed(0) + '% under 200 Hz, ' + (inst.hatHigh * 100).toFixed(0) + '% over 5 kHz)');

  // 4. Autosave already holds the notes (read from IndexedDB above); a
  // project file round trip keeps them too, with no audio file for them.
  const rt = await r.eval(`(function () {
    var p = ${JSON.stringify(p)};
    return ASEditStore.exportProject(p, new Map(), new Map()).then(function (zip) {
      return zip.arrayBuffer().then(function (ab) {
        var names = Object.keys(ASEditStore.readZip(ab));
        return ASEditStore.importProject(new File([ab], 'x.audiosaw')).then(function (res) {
          var s = res.project.sources[${JSON.stringify(c0 && c0.sourceId)}];
          return { names: names, notes: s && s.notes.length };
        });
      });
    });
  })()`);
  ok(rt.names.length === 1 && rt.names[0] === 'project.json' && rt.notes === 8, 'a project file keeps the notes in project.json and stores no audio for them (' + rt.names.join(', ') + ')');

  // 5. Bounce to audio from the clip menu, then undo.
  const rect = await r.eval('(function () { var b = document.getElementById("edLanes").getBoundingClientRect(); return { x: b.left, y: b.top }; })()');
  const rclick = async (x, y) => {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', buttons: 2, clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'right', buttons: 0, clickCount: 1 });
  };
  await rclick(rect.x + 40, rect.y + 30);
  await r.waitFor('!!document.querySelector(\'#edSheet [data-v="bounce"]\')');
  ok(await r.eval('!document.querySelector(\'#edSheet [data-v="fx"]\') && !!document.querySelector(\'#edSheet [data-v="notes"]\')'), 'a MIDI clip’s menu offers its notes and no Process');
  await r.eval('document.querySelector(\'#edSheet [data-v="bounce"]\').click()');
  await r.waitFor('/Bounced|Bounce failed/.test(document.getElementById("status").textContent)', 30000);
  await r.waitSaved();
  p = await r.project();
  const bc = p.tracks[0].clips[0];
  ok(p.sources[bc.sourceId].kind === 'derived', 'Bounce to audio replaces the notes with audio');
  const same = await r.eval(`(function () {
    var p = ${JSON.stringify(p)};
    return ASEditEngine.render(p, 0, 5, { sampleRate: 44100, channels: 2 }).then(function (res) {
      var d = res.buffer.getChannelData(0), out = [];
      for (var k = 0; k < 8; k++) out.push(__pitch(d, 44100, k * 0.6 + 0.1, k * 0.6 + 0.3));
      return { hz: out, peak: res.peak };
    });
  })()`);
  let bw = 0;
  same.hz.forEach((h, k) => { bw = Math.max(bw, Math.abs(1200 * Math.log2(h / scan.notes[k].hz))); });
  ok(bw < 5 && Math.abs(20 * Math.log10(same.peak / scan.peak)) < 0.5, 'the bounce sounds like the notes did (pitch within ' + bw.toFixed(1) + ' cents, peak within ' + Math.abs(20 * Math.log10(same.peak / scan.peak)).toFixed(2) + ' dB)');
  await r.eval('document.getElementById("edUndo").click()');
  await r.waitSaved();
  p = await r.project();
  ok(p.sources[p.tracks[0].clips[0].sourceId].kind === 'midi', 'undo brings the notes back');

  // 6. Convert to MIDI: a harmonic melody on a new track at 0:00.
  await r.eval('document.getElementById("edHome").click()');
  const MEL = [57, 60, 64, 62, 59];
  await r.eval(`(function () {
    var sr = 44100, notes = ${JSON.stringify(MEL)}, n = Math.round(sr * notes.length * 0.5), b = new AudioBuffer({ numberOfChannels: 1, length: n, sampleRate: sr }), d = b.getChannelData(0);
    notes.forEach(function (m, k) { var f = 440 * Math.pow(2, (m - 69) / 12), i0 = Math.round(k * 0.5 * sr), L = Math.round(0.45 * sr);
      for (var i = 0; i < L; i++) { var e = Math.min(1, i / 400) * Math.min(1, (L - i) / 800); for (var h = 1; h <= 5; h++) d[i0 + i] += 0.3 / h * e * Math.sin(2 * Math.PI * f * h * i / sr); } });
    var dt = new DataTransfer(); dt.items.add(new File([AudioSaw.audioBufferToWav(b)], 'melody.wav', { type: 'audio/wav' }));
    var i = document.getElementById('fileInput'); i.files = dt.files; i.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await r.waitFor('!document.getElementById("edSheet").hidden', 10000);
  await r.eval('var b = document.querySelector(\'#edSheet [data-v="tracks"]\'); if (b) b.click();');
  await r.waitFor('/Added melody/.test(document.getElementById("status").textContent)', 20000);
  await r.waitSaved();
  p = await r.project();
  const mti = p.tracks.findIndex((t) => t.clips.some((c) => c.name === 'melody'));
  ok(mti >= 0, 'the melody was added on its own track (' + p.tracks.map((t) => t.name + ':' + t.clips.map((c) => c.name).join('+')).join(', ') + ' / ' + (await r.eval('document.getElementById("status").textContent')) + ')');
  const mclip = p.tracks[mti].clips[0];
  // Right-click inside the melody clip: its row (tracks are 96 px at this
  // window size), a little into it.
  await rclick(rect.x + 40, rect.y + mti * 96 + 30);
  await r.waitFor('!!document.querySelector(\'#edSheet [data-v]\')', 5000);
  const hasTo = await r.eval('!!document.querySelector(\'#edSheet [data-v="tomidi"]\')');
  ok(hasTo, 'an audio clip offers Convert to MIDI');
  if (hasTo) {
    await r.eval('document.querySelector(\'#edSheet [data-v="tomidi"]\').click()');
    await r.waitFor('/notes from|No clear notes|Could not convert/.test(document.getElementById("status").textContent)', 30000);
    await r.waitSaved();
    p = await r.project();
    const mt = p.tracks[mti + 1], ms = mt && mt.clips[0] && p.sources[mt.clips[0].sourceId];
    const got = ms ? ms.notes.map((n) => n[0]) : [];
    ok(ms && ms.kind === 'midi' && JSON.stringify(got) === JSON.stringify(MEL), 'Convert to MIDI puts the melody’s notes on a new track under it (' + JSON.stringify(got) + ')');
    ok(mt && Math.abs(mt.clips[0].start - mclip.start) < 1e-6, 'lined up with the audio');
  }

  // 7. The note editor: opens on the first MIDI clip; Save writes a new source.
  p = await r.project();
  const beforeSrc = p.tracks[0].clips[0].sourceId;
  await rclick(rect.x + 40, rect.y + 30);
  await r.waitFor('!!document.querySelector(\'#edSheet [data-v="notes"]\')');
  await r.eval('document.querySelector(\'#edSheet [data-v="notes"]\').click()');
  await r.waitFor('!!document.querySelector("#edSheet canvas.ed-roll")');
  const drawn = await r.eval('(function () { var c = document.querySelector("#edSheet canvas.ed-roll"); return c.width > 100 && c.height > 100; })()');
  ok(drawn, 'the piano roll opens on the clip');
  await r.eval('document.querySelector(\'#edSheet [data-v="play"]\').click()');
  await sleep(400);
  const playing = await r.eval('document.querySelector(\'#edSheet [data-v="play"]\').textContent');
  await r.eval('document.querySelector(\'#edSheet [data-v="play"]\').click()');
  const stopped = await r.eval('document.querySelector(\'#edSheet [data-v="play"]\').textContent');
  ok(playing === 'Stop' && stopped === 'Play', 'Play in the note editor plays the unsaved notes and stops (' + playing + ' / ' + stopped + ')');
  await r.eval('document.querySelector(\'#edSheet [data-v="save"]\').click()');
  await r.waitSaved();
  p = await r.project();
  const after = p.sources[p.tracks[0].clips[0].sourceId];
  ok(p.tracks[0].clips[0].sourceId !== beforeSrc && after.kind === 'midi' && after.notes.length === 8, 'saving the notes writes a new source with the same 8 notes');
  // 8. Scale: a dense minute (1,700 notes) must export faster than it plays.
  // Built all at once, notes cost about twice real time to export; built a
  // little ahead of when they sound, about a thirtieth.
  const big = await r.eval(`(function () {
    var M = ASEditModel, p = M.create('big'), t = M.addTrack(p), notes = [], s = 7;
    function rnd() { s = (s * 16807) % 2147483647; return s / 2147483647; }
    for (var k = 0; k < 1700; k++) notes.push({ midi: 40 + Math.floor(rnd() * 44), start: rnd() * 60, duration: 0.1 + rnd() * 0.8, velocity: 60 + Math.floor(rnd() * 60) });
    M.addClip(p, t, { sourceId: M.addSource(p, { kind: 'midi', name: 'big', notes: notes }), start: 0 });
    var t0 = performance.now();
    return ASEditEngine.render(p, 0, 60, { sampleRate: 44100, channels: 2 }).then(function () { return performance.now() - t0; });
  })()`);
  ok(big < 60000, 'a minute of 1,700 notes exports faster than real time (' + (big / 1000).toFixed(1) + ' s)');
  notes.push('1,700 notes over a minute exported in ' + (big / 1000).toFixed(1) + ' s');

  // The harness hides navigator.serviceWorker (above), which pwa.js then
  // cannot call register on; that one is ours, not the page's.
  const errs = (await r.eval('window.__errs || []')).filter((e) => !/reading 'register'/.test(e));
  ok(!errs.length, 'no page errors (' + errs.join('; ') + ')');
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
      await waitFor('document.getElementById("edSaved").dataset.state === "saved"', 30000);
    },
    project: async () => JSON.parse(await evaluate(readProject))
  };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function connect(dir) {
  const f = path.join(dir, 'DevToolsActivePort');
  for (let i = 0; i < 300 && !fs.existsSync(f); i++) await sleep(100);
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
