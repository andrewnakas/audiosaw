#!/usr/bin/env node
/*
 * Checks js/dictation-vad.js, the utterance splitter behind /dictation, in
 * Node. A synthetic stream: room noise, then "speech" bursts (a 180 Hz
 * buzz with a syllable-rate envelope) of different lengths and loudness.
 *
 * What matters, and why:
 *   - each burst comes out as exactly one utterance, starting no later than
 *     the burst (the pre-roll keeps quiet word onsets) and ending within
 *     0.9 s of it (the 700 ms hang plus the 200 ms kept);
 *   - short pauses inside a phrase (300 ms) do not split it, or Whisper
 *     loses the context it needs to punctuate;
 *   - a click and noise alone produce nothing: Whisper turns silence into
 *     "Thank you.";
 *   - a 40 s monologue is cut at 25 s at most, inside Whisper's window;
 *   - a quiet speaker in a noisy room is still found (the floor adapts);
 *   - the result does not depend on how the stream is blocked up.
 */
const V = require('../js/dictation-vad.js');
let failed = 0;
function ok(c, m) { console.log((c ? '  ok  ' : '  FAIL ') + m); if (!c) failed++; }

const SR = 16000;
function rng(seed) { return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296 * 2 - 1); }
function build(events, noise, secs) {
  const n = Math.round(secs * SR), x = new Float32Array(n), r = rng(11);
  for (let i = 0; i < n; i++) x[i] = r() * noise;
  for (const e of events) {
    const a = Math.round(e.at * SR), b = Math.round((e.at + e.len) * SR);
    for (let i = a; i < b && i < n; i++) {
      const t = (i - a) / SR;
      if (e.gapAt != null && t > e.gapAt && t < e.gapAt + 0.3) continue;
      const env = e.click ? 1 : 0.55 + 0.45 * Math.sin(2 * Math.PI * 4 * t);
      x[i] += (e.click ? r() : Math.sin(2 * Math.PI * 180 * i / SR) + 0.4 * Math.sin(2 * Math.PI * 540 * i / SR)) * e.amp * env;
    }
  }
  return x;
}
function run(x, block) {
  const out = [];
  const seg = V.segmenter({ onUtterance: (u, info) => out.push(info) });
  for (let i = 0; i < x.length; i += block) seg.push(x.subarray(i, i + block));
  seg.flush();
  return out;
}

const events = [
  { at: 1.0, len: 1.6, amp: 0.2 },
  { at: 4.0, len: 2.5, amp: 0.05, gapAt: 1.0 },     // quiet, with a 300 ms pause inside
  { at: 8.0, len: 0.06, amp: 0.5, click: true },    // a click
  { at: 10.0, len: 0.8, amp: 0.3 }
];
const x = build(events, 0.003, 13);
const u = run(x, 2048);
const speech = events.filter((e) => !e.click);
ok(u.length === speech.length, `${speech.length} phrases give ${u.length} utterances (the click and the 300 ms pause do not count)`);
speech.forEach((e, i) => {
  const g = u[i];
  if (!g) return;
  ok(g.start <= e.at + 0.03 && g.start >= e.at - 0.35, `phrase ${i + 1}: starts at ${g.start.toFixed(2)} s (speech at ${e.at})`);
  ok(g.end >= e.at + e.len - 0.03 && g.end <= e.at + e.len + 0.9, `phrase ${i + 1}: ends at ${g.end.toFixed(2)} s (speech ends ${(e.at + e.len).toFixed(2)})`);
});
ok(run(build([], 0.01, 8), 4096).length === 0, 'noise alone gives nothing');
{
  const noisy = build([{ at: 2, len: 2, amp: 0.06 }], 0.02, 6);
  ok(run(noisy, 1024).length === 1, 'a quiet voice (-24 dBFS) over loud room noise (-34 dBFS) is found');
}
{
  const mono = build([{ at: 0.5, len: 40, amp: 0.2 }], 0.003, 42);
  const us = run(mono, 4096);
  ok(us.length >= 2 && us.every((g) => g.end - g.start <= 25.05), `a 40 s monologue is cut into ${us.length} pieces of at most 25 s`);
}
{
  const a = run(x, 128).map((g) => g.start.toFixed(2) + '-' + g.end.toFixed(2)).join(',');
  const b = run(x, 16000).map((g) => g.start.toFixed(2) + '-' + g.end.toFixed(2)).join(',');
  ok(a === b, 'block size does not change the cut points');
}
ok(V.phantom(' Thank you.') && V.phantom('[BLANK_AUDIO]') && V.phantom('(music)') && !V.phantom('Thank you for the report.'), "Whisper's stock silence lines are recognised, real sentences are not");

// The page itself, with a spoken sentence as the microphone. Needs macOS
// `say`, ffmpeg and Whisper base in the local mirror (model-mirror.js fetches
// it once), so it runs only with DICTATION_BROWSER=1.
async function browser() {
  if (!process.env.DICTATION_BROWSER) { console.log('  skip: page test (DICTATION_BROWSER=1 runs it)'); return; }
  const fs = require('fs'), os = require('os'), path = require('path');
  const { execFileSync } = require('child_process');
  const { withPage } = require('./chrome-harness');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'as-dict-'));
  const SENT = 'The quick brown fox jumps over the lazy dog. Then it goes home for dinner.';
  execFileSync('say', ['-o', path.join(dir, 's.aiff'), SENT]);
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-t', '1.5', path.join(dir, 'z.wav')]);
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', path.join(dir, 'z.wav'), '-i', path.join(dir, 's.aiff'), '-i', path.join(dir, 'z.wav'), '-i', path.join(dir, 'z.wav'),
    '-filter_complex', '[0][1][2][3]concat=n=4:v=0:a=1,aresample=48000', '-ac', '1', '-c:a', 'pcm_s16le', path.join(dir, 'in.wav')]);
  // The microphone is a MediaStream playing the spoken file. Chrome's
  // --use-file-for-fake-audio-capture delivered only zeros in headless mode
  // (any WAV, any path), while its default fake device beeps fine; from the
  // stream onward this is the page's own path.
  const mirror = require('./model-mirror');
  mirror.fetch('onnx-community/whisper-base', mirror.WHISPER_BASE);
  await withPage({ headers: true, routes: Object.assign(mirror.routes(['onnx-community/whisper-base']), { '/__speech.wav': () => fs.readFileSync(path.join(dir, 'in.wav')) }) }, async (page) => {
    await mirror.attach(page, ['onnx-community/whisper-base']);
    await page.goto('/dictation', 1500);
    await page.eval(`(() => {
      navigator.mediaDevices.getUserMedia = async () => {
        const c = new AudioContext();
        const buf = await c.decodeAudioData(await (await fetch('/__speech.wav')).arrayBuffer());
        const s = c.createBufferSource(); s.buffer = buf;
        const d = c.createMediaStreamDestination(); s.connect(d); s.start(c.currentTime + 0.2);
        return d.stream;
      };
      return 1;
    })()`);
    await page.eval(`document.querySelector('#model').value = 'onnx-community/whisper-base';
      document.querySelector('#language').value = 'en';
      document.querySelector('#dictText').value = ''; true`);
    // A real click: headless Chrome only runs an AudioContext after user
    // input, which is also how a visitor starts dictating.
    const box = await page.eval(`(() => { const b = document.querySelector('#micBtn'); b.scrollIntoView(); const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
    const r = await page.eval(`(async () => {
      for (let i = 0; i < 50 && !window.__dict.state().listening; i++) await new Promise((r) => setTimeout(r, 100));
      const t0 = Date.now();
      window.__lv = [];
      const iv = setInterval(() => { try { window.__lv.push(window.__dict.level()); } catch (e) {} }, 250);
      // The fake file plays once (about 6 s); then wait for the queue to drain.
      await new Promise((r) => setTimeout(r, 9000));
      window.__dict.stop();
      clearInterval(iv);
      for (;;) {
        const s = window.__dict.state();
        if (!s.busy && !s.queue) break;
        if (Date.now() - t0 > 1500000) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      return { lv: window.__lv.map((v) => +v.toFixed(4)).join(','), text: document.querySelector('#dictText').value, state: window.__dict.state(), status: document.querySelector('#status').textContent };
    })()`, 1600000);
    const words = r.text.toLowerCase().replace(/[^a-z ]/g, '').split(/\s+/);
    const want = ['quick', 'brown', 'fox', 'lazy', 'dog', 'home', 'dinner'];
    const hit = want.filter((w) => words.includes(w)).length;
    ok(hit >= 6, `dictated text: "${r.text}" (${hit}/${want.length} key words)` + (hit < 6 ? " — " + JSON.stringify(r.state) + " " + r.status + " levels " + r.lv : ""));
    ok(/[.!?]$/.test(r.text.trim()) && /^[A-Z]/.test(r.text.trim()), 'Whisper punctuated and capitalised it');
    if (page.logs.length) console.log('    console: ' + page.logs.slice(0, 4).join(' | '));
  });
}

browser().catch((e) => { ok(false, 'page test: ' + (e.stack || e)); }).then(() => {
  if (failed) { console.log(`\n${failed} check(s) failed`); process.exit(1); }
  console.log('\ncheck-dictation: all good');
});
