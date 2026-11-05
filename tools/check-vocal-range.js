#!/usr/bin/env node
/*
 * Checks /vocal-range-test (js/vocal-range.js + js/vocal-range-page.js).
 *
 * Node (ASRange.Meter fed readings every 50 ms, as the page does):
 *   - a held note counts after 300 ms, and the range is its lowest and
 *     highest held notes, named right;
 *   - a blip shorter than 300 ms never counts, nor a glide faster than
 *     5 semitones a second, nor low-clarity readings (breath, noise);
 *   - vibrato of +-60 cents at 5.5 Hz does not break a hold;
 *   - a note 30 cents sharp still counts as that note;
 *   - each voice type's own range classifies as that type.
 * Browser: getUserMedia is replaced by a sawtooth whose pitch is scheduled
 * on its AudioContext (a held A2, a fast glide up two octaves, an 880 Hz
 * blip of 150 ms, a held G4); the live page must read A2 to G4, baritone,
 * and fire convert_success once. Then a WAV of the same through the page's
 * "use a recording" box must read the same.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const A = require('../js/vocal-range.js');

let failed = 0;
const ok = (c, m) => { console.log((c ? '  ok  ' : '  FAIL ') + m); if (!c) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('meter');
{
  const run = (steps) => { const m = new A.Meter(); let t = 0; steps.forEach(([f, dur, clarity]) => { for (let k = 0; k < Math.round(dur / 0.05); k++) { m.feed(typeof f === 'function' ? f(k * 0.05) : f, clarity == null ? 0.95 : clarity, t); t += 0.05; } }); return m.result(); };
  const hz = A.hzOf;
  let r = run([[hz(45), 1], [0, 0.3], [hz(67), 1]]);
  ok(r && r.loName === 'A2' && r.hiName === 'G4' && r.semitones === 22, 'held A2 and G4: range A2-G4, 22 semitones (' + (r && r.loName + '-' + r.hiName) + ')');
  r = run([[hz(55), 1], [hz(81), 0.25], [hz(62), 1]]);
  ok(r && r.hiName === 'D4', 'a 250 ms blip on A5 does not count (high ' + (r && r.hiName) + ')');
  r = run([[hz(48), 0.6], [(t) => hz(48 + t * 6), 4], [hz(72), 0.6]]);
  ok(r && r.loName === 'C3' && r.hiName === 'C5', 'a glide of 6 semitones a second between held C3 and C5: range C3-C5');
  const m6 = new A.Meter(); let t6 = 0; for (let k = 0; k < 40; k++) { m6.feed(hz(48 + k * 0.3), 0.95, t6); t6 += 0.05; }
  ok(!m6.result(), 'a glide of 6 semitones a second on its own counts no note');
  r = run([[hz(64), 2, 0.6]]);
  ok(!r, 'readings with poor clarity (breath, noise) count nothing');
  r = run([[(t) => hz(57 + 0.6 * Math.sin(2 * Math.PI * 5.5 * t)), 1.5]]);
  ok(r && r.loName === 'A3' && r.hiName === 'A3', 'vibrato of +-60 cents at 5.5 Hz holds A3 (' + (r && r.loName) + ')');
  r = run([[hz(60) * Math.pow(2, 0.3 / 12), 0.6]]);
  ok(r && r.loName === 'C4', 'a C4 sung 30 cents sharp counts as C4');
  const exp = A.TYPES.map((t) => [Math.round(t.lo), Math.round(t.hi), t.name]);
  const bad = exp.filter(([lo, hi, n]) => A.classify(lo, hi).type.name !== n);
  ok(!bad.length, 'each voice type\'s own range classifies as that type' + (bad.length ? ' (wrong: ' + bad.map((b) => b[2]).join(', ') + ')' : ''));
  ok(A.classify(43, 67).type.name === 'Baritone' && A.classify(38, 62).type.name === 'Bass' && A.classify(62, 86).type.name === 'Soprano', 'G2-G4 baritone, D2-D4 bass, D4-D6 soprano');
}

// Runs in the page: the microphone becomes a scheduled sawtooth.
const SCHEDULE = [[110, 0, 1], [0, 1, 1.2], ['glide', 1.2, 2.4, 110, 440], [0, 2.4, 2.6], [880, 2.6, 2.75], [0, 2.75, 3], [392, 3, 4], [0, 4, 9]];
const fake = `(function () {
  window.__events = [];
  var orig = CV.track; CV.track = function (n, p) { window.__events.push([n, p]); return orig.apply(this, arguments); };
  navigator.mediaDevices.getUserMedia = async function () {
    var c = new AudioContext(); await c.resume();
    var o = c.createOscillator(); o.type = 'sawtooth';
    var g = c.createGain(); g.gain.value = 0;
    var lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3000;
    o.connect(lp).connect(g); var d = c.createMediaStreamDestination(); g.connect(d); o.start();
    var t0 = c.currentTime + 0.3;
    ${JSON.stringify(SCHEDULE)}.forEach(function (s) {
      if (s[0] === 'glide') { o.frequency.setValueAtTime(s[3], t0 + s[1]); o.frequency.exponentialRampToValueAtTime(s[4], t0 + s[2]); g.gain.setValueAtTime(0.3, t0 + s[1]); }
      else if (s[0] === 0) g.gain.setValueAtTime(0, t0 + s[1]);
      else { o.frequency.setValueAtTime(s[0], t0 + s[1]); g.gain.setValueAtTime(0.3, t0 + s[1]); }
    });
    window.__fakeCtx = c;
    return d.stream;
  };
})()`;

async function main() {
  const { withPage, findChrome } = require('./chrome-harness');
  if (!findChrome()) { console.log('  skip: page (no Chrome)'); return; }
  console.log('page');
  await withPage({}, async (page) => {
    await page.goto('/vocal-range-test', 1000);
    await page.eval(fake);
    const b = await page.eval('(function () { var e = document.getElementById("rStart"); e.scrollIntoView({ block: "center" }); var r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()');
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x, y: b.y, button: 'left', buttons: 1, clickCount: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(6500);
    const s = await page.eval('Object.assign(window.__range.state(), { events: window.__events })');
    const r = s.result || {};
    ok(r.loName === 'A2' && r.hiName === 'G4', 'live: a held A2 and G4 around a fast glide and a 150 ms A5 read A2 to G4 (' + s.low + ' to ' + s.high + ')');
    ok(/^Baritone/.test(s.type), 'live: "' + s.type + '"');
    const succ = s.events.filter((e) => e[0] === 'convert_success' && e[1].target_format === 'range').length;
    ok(succ === 1, 'live: convert_success once (' + succ + ')');

    // The same as a recording, through the page's file box.
    const R = 44100, n = 5 * R, x = new Float32Array(n);
    let ph = 0;
    for (let i = 0; i < n; i++) {
      const t = i / R; let f = 0;
      for (const s2 of SCHEDULE) { if (t >= s2[1] && t < s2[2]) f = s2[0] === 'glide' ? s2[3] * Math.pow(s2[4] / s2[3], (t - s2[1]) / (s2[2] - s2[1])) : s2[0]; }
      if (!f) { ph = 0; continue; }
      ph += f / R; let v = 0; for (let h = 1; h <= 8; h++) v += Math.sin(2 * Math.PI * h * ph) / h;
      x[i] = 0.2 * v;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'as-range-')), wav = path.join(dir, 'sing.wav');
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'f32le', '-ar', String(R), '-ac', '1', '-i', '-', '-c:a', 'pcm_s16le', wav], { input: Buffer.from(x.buffer) });
    const f = await page.eval(`(async () => {
      const bin = atob('${fs.readFileSync(wav).toString('base64')}'); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      const dt = new DataTransfer(); dt.items.add(new File([u], 'sing.wav', { type: 'audio/wav' }));
      const input = document.getElementById('fileInput'); input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true }));
      for (let i = 0; i < 100 && !/success|error/.test(document.getElementById('status').className); i++) await new Promise((r) => setTimeout(r, 200));
      return Object.assign(window.__range.state(), { status: document.getElementById('status').textContent });
    })()`);
    ok(f.result && f.result.loName === 'A2' && f.result.hiName === 'G4' && /^Baritone/.test(f.type), 'recording: ' + f.status + ' ' + f.type);
    const errs = page.logs.filter((l) => !/scriptwrapper|ERR_CONNECTION_REFUSED|favicon/.test(l));
    ok(!errs.length, 'no page errors' + (errs.length ? ': ' + errs.join(' | ').slice(0, 300) : ''));
  });
}

main().then(() => {
  if (failed) { console.log('\ncheck-vocal-range: ' + failed + ' failed'); process.exit(1); }
  console.log('\ncheck-vocal-range: all good');
}).catch((e) => { console.error(e); process.exit(1); });
