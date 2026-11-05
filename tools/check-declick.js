#!/usr/bin/env node
/*
 * Checks /click-remover (js/declick.js + js/declick-page.js).
 *
 * Fixtures (in Node): a chord progression with bass and drums, and `say`
 * speech, each with a -60 dBFS noise floor (a transfer's hiss), and clicks
 * at known places. The clicks are built the way a record player makes them:
 * one to four impulses through RIAA de-emphasis (its 75 us pole is the fast
 * decay) plus the cartridge's resonance at 6-16 kHz, 0.1 to 1.5 ms long, from
 * -26 to -4 dBFS. A smooth millisecond-long bump is not a click: a first
 * fixture made of those could not be found by any rule, and the physics says
 * a real one is gone in about 0.35 ms unless it is several impulses.
 *
 * At the default sensitivity:
 *   - at least 95% of the clicks peaking above -14 dBFS are found, and 85% of
 *     all of them (the ones missed sit on drum hits, where the rule that a
 *     click must stop before the music's own error does holds back);
 *   - a repaired click is at least 14 dB quieter (median, energy against the
 *     clean original);
 *   - clean drums are not touched, and clean music at most twice in 30 s;
 *   - every sample outside the repaired spans is bit-identical to the input.
 * Browser: the real page on a stereo WAV, the same measures on its output.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const D = require('../js/declick.js');

let failed = 0;
const ok = (c, m) => { console.log((c ? '  ok  ' : '  FAIL ') + m); if (!c) failed++; };

// Shared fixtures for the declick spike/check.
const R = 48000;
function rnd(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

// Music: a chord progression of decaying harmonic tones, a bass line and drums.
function music(sec, seed, drums = true) {
  const r = rnd(seed), n = Math.round(sec * R), x = new Float32Array(n);
  const chords = [[60, 64, 67], [57, 60, 64], [65, 69, 72], [67, 71, 74]];
  const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);
  const bpm = 100, beat = 60 / bpm;
  for (let b = 0; b * beat < sec; b++) {
    const t0 = b * beat, ch = chords[Math.floor(b / 4) % 4];
    const notes = b % 2 === 0 ? ch : [ch[1] + 12];
    notes.forEach((m) => {
      const f = hz(m), s0 = Math.round(t0 * R), len = Math.round(beat * 2 * R), ph = r() * 6.28;
      for (let i = 0; i < len && s0 + i < n; i++) {
        const t = i / R, env = Math.exp(-t * 2.5) * Math.min(1, t / 0.004) * Math.min(1, (len - i) / (0.2 * len));
        let v = 0; for (let h = 1; h <= 6; h++) v += Math.sin(2 * Math.PI * f * h * t + ph * h) / (h * h);
        x[s0 + i] += 0.08 * env * v;
      }
    });
    // Bass on every beat.
    const fb = hz(ch[0] - 24), s0 = Math.round(t0 * R);
    for (let i = 0; i < beat * R && s0 + i < n; i++) { const t = i / R; x[s0 + i] += 0.15 * Math.exp(-t * 3) * Math.min(1, t / 0.01) * Math.min(1, (beat * R - i) / (0.2 * beat * R)) * Math.sin(2 * Math.PI * fb * t); }
    if (drums) addDrums(x, t0, b, r, 1);
  }
  return x;
}

function addDrums(x, t0, b, r, g) {
  const n = x.length, s0 = Math.round(t0 * R);
  if (b % 2 === 0) { // kick
    let ph = 0;
    for (let i = 0; i < 0.5 * R && s0 + i < n; i++) { const t = i / R; ph += 2 * Math.PI * (50 + 100 * Math.exp(-t * 30)) / R; x[s0 + i] += g * 0.5 * Math.exp(-t * 12) * Math.min(1, (0.5 * R - i) / (0.2 * R)) * Math.sin(ph); }
  } else { // snare: tone + noise
    let lp = 0;
    for (let i = 0; i < 0.3 * R && s0 + i < n; i++) { const t = i / R; lp += 0.5 * ((r() - 0.5) - lp); x[s0 + i] += g * Math.min(1, (0.3 * R - i) / (0.1 * R)) * (0.3 * Math.exp(-t * 20) * lp * 2 + 0.15 * Math.exp(-t * 30) * Math.sin(2 * Math.PI * 190 * t)); }
  }
  // hi-hats on eighths
  for (const off of [0, 0.5]) {
    const h0 = Math.round((t0 + off * 0.6) * R); let hp = 0, prev = 0;
    for (let i = 0; i < 0.08 * R && h0 + i < n; i++) { const t = i / R, w = r() - 0.5; hp = 0.9 * (hp + w - prev); prev = w; x[h0 + i] += g * 0.12 * Math.exp(-t * 80) * Math.min(1, (0.08 * R - i) / (0.03 * R)) * hp; }
  }
}

function drumsOnly(sec, seed) {
  const r = rnd(seed), x = new Float32Array(Math.round(sec * R)), beat = 0.6;
  for (let b = 0; b * beat < sec; b++) addDrums(x, b * beat, b, r, 1.4);
  return x;
}

// Clicks as a record player makes them: one to four impulses (a speck of
// dust, a scratch's edges) through RIAA de-emphasis, whose 75 us pole is the
// fast decay, plus the cartridge's resonance ringing at 6-16 kHz. 0.1 to
// 1.5 ms long, at known places at least 30 ms apart.
function clicks(len, count, seed, ampLo = 0.05, ampHi = 0.6) {
  const r = rnd(seed), list = [];
  const spacing = Math.floor(len / count), tau = 75e-6 * R;
  for (let c = 0; c < count; c++) {
    const at = c * spacing + Math.round(0.01 * R + r() * (spacing - 0.03 * R));
    const dur = Math.max(5, Math.round((0.0001 + r() * 0.0014) * R));
    const amp = ampLo * Math.pow(ampHi / ampLo, r());
    const nimp = dur > 15 ? 1 + Math.floor(r() * 4) : 1;
    const fr = 6000 + r() * 10000, rdecay = dur / 3;
    const w = new Float32Array(dur);
    for (let k = 0; k < nimp; k++) {
      const p0 = k === 0 ? 0 : Math.floor(r() * dur * 0.7), a = amp * (k === 0 ? 1 : 0.3 + r() * 0.7) * (r() < 0.5 ? -1 : 1);
      for (let i = p0; i < dur; i++) {
        const t = i - p0;
        w[i] += a * (Math.exp(-t / tau) + 0.3 * Math.exp(-t / rdecay) * Math.sin(2 * Math.PI * fr * t / R));
      }
    }
    list.push({ at, dur, w });
  }
  return list;
}

// A transfer's noise floor (vinyl surface, tape hiss), -60 dBFS RMS by default.
function floor(x, db, seed) { const r = rnd(seed || 11), g = Math.pow(10, (db || -60) / 20) * 3.464; for (let i = 0; i < x.length; i++) x[i] += g * (r() - 0.5); return x; }

function addClicks(x, list) { const y = Float32Array.from(x); list.forEach((c) => { for (let i = 0; i < c.dur; i++) y[c.at + i] += c.w[i]; }); return y; }


function score(clean, list, out, found) {
  const by = { big: [0, 0], all: [0, 0] }, imp = [];
  list.forEach((c) => {
    const pk = Math.max(...c.w.map(Math.abs)), hit = found.some((q) => q[0] < c.at + c.dur && q[1] > c.at);
    by.all[1]++; if (hit) by.all[0]++;
    if (pk >= 0.2) { by.big[1]++; if (hit) by.big[0]++; }
    if (hit) {
      let a = 0, b = 0;
      for (let i = c.at - 5; i < c.at + c.dur + 15; i++) { const d = clean[i] + c.w[Math.min(c.dur - 1, Math.max(0, i - c.at))] * (i >= c.at && i < c.at + c.dur ? 1 : 0); a += (d - clean[i]) ** 2; b += (out[i] - clean[i]) ** 2; }
      imp.push(10 * Math.log10(a / Math.max(b, 1e-30)));
    }
  });
  imp.sort((u, v) => u - v);
  return { big: by.big, all: by.all, median: imp.length ? imp[imp.length >> 1] : 0 };
}

function untouched(dirty, out, found) {
  let bad = 0, j = 0;
  for (let i = 0; i < dirty.length; i++) {
    while (j < found.length && found[j][1] <= i) j++;
    if (j < found.length && i >= found[j][0]) continue;
    if (out[i] !== dirty[i]) bad++;
  }
  return bad;
}

function report(name, clean, list) {
  const dirty = addClicks(clean, list), t0 = Date.now();
  const res = D.process([dirty], R, { sensitivity: 'normal' }), s = score(clean, list, res.channels[0], res.clicks[0]);
  const ms = Date.now() - t0;
  ok(s.big[0] / s.big[1] >= 0.95, name + ': ' + s.big[0] + ' of ' + s.big[1] + ' clicks above -14 dBFS found');
  ok(s.all[0] / s.all[1] >= 0.85, name + ': ' + s.all[0] + ' of ' + s.all[1] + ' clicks found in all');
  ok(s.median >= 14, name + ': a repaired click is ' + s.median.toFixed(1) + ' dB quieter (median)');
  const bad = untouched(dirty, res.channels[0], res.clicks[0]);
  ok(bad === 0, name + ': outside the ' + res.count + ' repaired spans (' + res.samples + ' samples), every sample is the input\'s (' + bad + ' differ); ' + (clean.length / R).toFixed(0) + ' s in ' + ms + ' ms');
  return s;
}

async function main() {
  console.log('core');
  const m = floor(music(30, 1));
  report('music', m, clicks(m.length, 150, 2));
  const dr = D.process([floor(drumsOnly(30, 3))], R, { sensitivity: 'normal' });
  ok(dr.count === 0, 'clean drums: ' + dr.count + ' spans touched in 30 s (50 kicks and snares, 100 hi-hats)');
  const cm = D.process([m], R, { sensitivity: 'normal' });
  ok(cm.count <= 2, 'clean music: ' + cm.count + ' spans touched in 30 s');
  let speech = null;
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'as-declick-'));
    execFileSync('say', ['-v', 'Daniel', '-o', path.join(dir, 's.aiff'), 'The old record had not been played for forty years. It crackled and popped from the first groove, but under the noise the band was still there, the clarinet bright and the singer close to the microphone, as if the room had been waiting all that time.']);
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', path.join(dir, 's.aiff'), '-ar', String(R), '-ac', '1', '-f', 'f32le', path.join(dir, 's.raw')]);
    const b = fs.readFileSync(path.join(dir, 's.raw'));
    speech = new Float32Array(b.buffer, b.byteOffset, b.length / 4).slice();
    let pk = 0; for (const v of speech) pk = Math.max(pk, Math.abs(v));
    for (let i = 0; i < speech.length; i++) speech[i] *= 0.5 / pk;
    floor(speech);
  } catch (e) { console.log('  skip: speech (needs say and ffmpeg)'); }
  if (speech) {
    report('speech', speech, clicks(speech.length, Math.round(speech.length / R * 4), 5));
    const cs = D.process([speech], R, { sensitivity: 'normal' });
    ok(cs.count <= 1, 'clean speech: ' + cs.count + ' spans touched in ' + (speech.length / R).toFixed(0) + ' s');
  }

  const { withPage, findChrome } = require('./chrome-harness');
  if (!findChrome()) { console.log('  skip: page (no Chrome)'); return; }
  console.log('page');
  const n = 20 * R, L = floor(music(20, 7)), Rr = floor(music(20, 8), -60, 13), lc = clicks(n, 80, 9), rc = clicks(n, 80, 10);
  const dl = addClicks(L, lc), drr = addClicks(Rr, rc), inter = new Float32Array(2 * n);
  for (let i = 0; i < n; i++) { inter[2 * i] = dl[i]; inter[2 * i + 1] = drr[i]; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'as-declick-p-')), wav = path.join(dir, 'lp.wav');
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'f32le', '-ar', String(R), '-ac', '2', '-i', '-', '-c:a', 'pcm_f32le', wav], { input: Buffer.from(inter.buffer) });
  await withPage({}, async (page) => {
    await page.goto('/click-remover', 1500);
    const r = await page.eval(`(async () => {
      const bin = atob('${fs.readFileSync(wav).toString('base64')}'); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      const dt = new DataTransfer(); dt.items.add(new File([u], 'lp.wav', { type: 'audio/wav' }));
      const input = document.getElementById('fileInput'); input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true }));
      document.getElementById('outFmt').value = 'wav32f';
      let out = null, name = null; const orig = CV.downloadBlob; CV.downloadBlob = (b, n) => { out = b; name = n; };
      document.getElementById('convertBtn').click();
      for (let i = 0; i < 2400 && !out && !/error/.test(document.getElementById('status').className); i++) await new Promise((r) => setTimeout(r, 250));
      CV.downloadBlob = orig;
      if (!out) return { err: document.getElementById('status').textContent };
      const ab = new Uint8Array(await out.arrayBuffer()); let s = ''; for (let i = 0; i < ab.length; i += 0x8000) s += String.fromCharCode.apply(null, ab.subarray(i, i + 0x8000));
      return { name, b64: btoa(s), report: document.getElementById('rCount').textContent };
    })()`, 900000);
    if (r.err) { ok(false, 'page: ' + r.err); return; }
    const outF = path.join(dir, 'out.wav'); fs.writeFileSync(outF, Buffer.from(r.b64, 'base64'));
    const raw = execFileSync('ffmpeg', ['-loglevel', 'error', '-i', outF, '-f', 'f32le', '-'], { maxBuffer: 1 << 28 });
    const y = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4), yl = new Float32Array(n), yr = new Float32Array(n);
    for (let i = 0; i < n; i++) { yl[i] = y[2 * i]; yr[i] = y[2 * i + 1]; }
    // Spans the page touched: wherever the output differs from the input.
    const spans = (a, b) => { const s = []; for (let i = 0; i < n; i++) if (a[i] !== b[i]) { if (s.length && i - s[s.length - 1][1] < 4) s[s.length - 1][1] = i + 1; else s.push([i, i + 1]); } return s; };
    const sl = score(L, lc, yl, spans(dl, yl)), sr = score(Rr, rc, yr, spans(drr, yr));
    ok(y.length === 2 * n && (sl.all[0] + sr.all[0]) / (sl.all[1] + sr.all[1]) >= 0.85 && Math.min(sl.median, sr.median) >= 14,
      'page: ' + r.name + ', both channels, ' + (sl.all[0] + sr.all[0]) + ' of ' + (sl.all[1] + sr.all[1]) + ' clicks repaired, ' + Math.min(sl.median, sr.median).toFixed(1) + ' dB quieter (median); report: "' + r.report + '"');
    const errs = page.logs.filter((l) => !/scriptwrapper|ERR_CONNECTION_REFUSED|favicon/.test(l));
    ok(!errs.length, 'no page errors' + (errs.length ? ': ' + errs.join(' | ').slice(0, 300) : ''));
  });
}

main().then(() => {
  if (failed) { console.log('\ncheck-declick: ' + failed + ' failed'); process.exit(1); }
  console.log('\ncheck-declick: all good');
}).catch((e) => { console.error(e); process.exit(1); });
