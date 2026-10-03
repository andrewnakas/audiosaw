#!/usr/bin/env node
/*
 * Checks js/voice-fx.js (the /voice-changer DSP) in Node on a synthetic voice:
 * a band-limited glottal pulse train through three formant resonators, with
 * an unvoiced "s" (high-passed noise) in the middle and silence around it.
 *
 * Why these assertions:
 *   - pitch lands within 3 cents of the request, as the page says (measured
 *     worst 2.1), measured with YIN on the
 *     output (a wrong grain spacing is audible as out of tune, not an error);
 *   - a pitch-only shift keeps the formants (LPC F1/F2 within 10%), and a
 *     formant shift moves them by about the ratio asked for: that
 *     separation is the whole reason to use PSOLA rather than resampling;
 *   - the length is exactly the input's, so a clip sent from the editor
 *     comes back aligned;
 *   - the unvoiced "s" keeps its level, so consonants survive a shift;
 *   - the robot preset is monotone; every preset is finite, audible, below
 *     -1 dBFS peak.
 */
const V = require('../js/voice-fx.js');
require('../js/pitch-track.js');
const P = globalThis.ASPitch;

let failed = 0;
function ok(c, m) { console.log((c ? '  ok  ' : '  FAIL ') + m); if (!c) failed++; }

const SR = 44100;
function rng(seed) { return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296); }

function voice(f0, secs, opts = {}) {
  const n = Math.round(secs * SR), x = new Float32Array(n), r = rng(7);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const hz = f0 * (1 + 0.01 * Math.sin(2 * Math.PI * 5 * t));
    ph += hz / SR;
    // band-limited sawtooth: harmonics up to 5 kHz, 1/k rolloff
    let v = 0;
    for (let k = 1; k * hz < 5000; k++) v += Math.sin(2 * Math.PI * k * ph) / k;
    x[i] = v * 0.2;
  }
  // formants: F1 700, F2 1220, F3 2600 (an "ah")
  const res = (y, f, bw) => {
    const R = Math.exp(-Math.PI * bw / SR), a1 = -2 * R * Math.cos(2 * Math.PI * f / SR), a2 = R * R;
    const o = new Float32Array(y.length); let y1 = 0, y2 = 0;
    for (let i = 0; i < y.length; i++) { const v = y[i] * (1 - R) - a1 * y1 - a2 * y2; y2 = y1; y1 = v; o[i] = v; }
    return o;
  };
  const a = res(x, 700, 110), b = res(x, 1220, 120), c = res(x, 2600, 160);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = a[i] * 1.0 + b[i] * 0.6 + c[i] * 0.3;
  let pk = 0; for (const v of out) pk = Math.max(pk, Math.abs(v));
  for (let i = 0; i < n; i++) out[i] *= 0.5 / pk;
  // fade in/out 20 ms
  const f = Math.round(0.02 * SR);
  for (let i = 0; i < f; i++) { out[i] *= i / f; out[n - 1 - i] *= i / f; }
  return out;
}
function noise(secs, level) {
  const n = Math.round(secs * SR), x = new Float32Array(n), r = rng(3);
  let p = 0;
  for (let i = 0; i < n; i++) { const w = r() * 2 - 1; x[i] = (w - p) * level; p = w; }
  return x;
}
function concat(...parts) {
  const n = parts.reduce((a, p) => a + p.length, 0), o = new Float32Array(n); let off = 0;
  for (const p of parts) { o.set(p, off); off += p.length; }
  return o;
}

const vowel1 = voice(140, 1.2), sss = noise(0.35, 0.15), vowel2 = voice(140, 1.0);
const gap = new Float32Array(Math.round(0.2 * SR));
const input = concat(gap, vowel1, sss, vowel2, gap);
const segV = [gap.length + Math.round(0.2 * SR), gap.length + vowel1.length - Math.round(0.2 * SR)];
const segS = [gap.length + vowel1.length + Math.round(0.05 * SR), gap.length + vowel1.length + sss.length - Math.round(0.05 * SR)];

function medianF0(x, [a, b]) {
  const fr = P.track(x.subarray(a, b), SR, { minHz: 50, maxHz: 900 }).filter((f) => f.clarity > 0.8).map((f) => f.hz).sort((p, q) => p - q);
  return fr.length ? fr[fr.length >> 1] : 0;
}
function f0Spread(x, [a, b]) {
  const fr = P.track(x.subarray(a, b), SR, { minHz: 50, maxHz: 900 }).filter((f) => f.clarity > 0.8).map((f) => f.hz);
  const m = fr.reduce((s, v) => s + v, 0) / fr.length;
  return Math.sqrt(fr.reduce((s, v) => s + (v - m) * (v - m), 0) / fr.length);
}
function rms(x, [a, b]) { let e = 0; for (let i = a; i < b; i++) e += x[i] * x[i]; return Math.sqrt(e / (b - a)); }
// Formants by LPC (decimated to 11 kHz, order 12, pre-emphasis, envelope
// peaks averaged over frames): the standard estimate, and unlike a spectral
// centroid it does not move just because the harmonics are spaced wider.
const R = require('../js/resample.js');
function formants(x, [a, b], sr = SR) {
  const y = R.channel(x.subarray(a, b), sr, 11025), fs = 11025, N = 512, order = 12;
  const env = new Float64Array(3500); let cnt = 0;
  for (let s = 0; s + N <= y.length; s += 256) {
    const w = new Float64Array(N);
    for (let i = 0; i < N; i++) w[i] = (y[s + i] - (i ? 0.97 * y[s + i - 1] : 0)) * (0.54 - 0.46 * Math.cos(2 * Math.PI * i / (N - 1)));
    const r = new Float64Array(order + 1);
    for (let k = 0; k <= order; k++) for (let i = k; i < N; i++) r[k] += w[i] * w[i - k];
    if (r[0] <= 0) continue;
    r[0] *= 1.0001;
    let A = new Float64Array(order + 1); A[0] = 1; let E = r[0];
    for (let i = 1; i <= order; i++) {
      let acc = r[i]; for (let j = 1; j < i; j++) acc += A[j] * r[i - j];
      const k = -acc / E; const nA = A.slice();
      for (let j = 1; j < i; j++) nA[j] = A[j] + k * A[i - j]; nA[i] = k; A = nA; E *= (1 - k * k);
    }
    for (let f = 150; f < 3500; f += 5) {
      let re = 0, im = 0; const wv = 2 * Math.PI * f / fs;
      for (let j = 0; j <= order; j++) { re += A[j] * Math.cos(wv * j); im -= A[j] * Math.sin(wv * j); }
      env[f] += -10 * Math.log10(re * re + im * im);
    }
    cnt++;
  }
  const pk = [];
  for (let f = 155; f < 3495; f += 5) if (env[f] > env[f - 5] && env[f] >= env[f + 5]) pk.push(f);
  return pk.slice(0, 3);
}


const cents = (a, b) => 1200 * Math.log2(a / b);

const f0in = medianF0(input, segV), fin = formants(input, segV), sin = rms(input, segS);
console.log(`input: f0 ${f0in.toFixed(1)} Hz, F1 ${fin[0]} Hz, F2 ${fin[1]} Hz`);
// Mean |log ratio| of F1 and F2 against a target ratio.
const fmErr = (f, want) => (Math.abs(Math.log(f[0] / fin[0] / want)) + Math.abs(Math.log(f[1] / fin[1] / want))) / 2;

for (const st of [-7, -4, 4, 7]) {
  const [y] = V.shift([input], SR, { pitch: st });
  const f = medianF0(y, segV), fm = formants(y, segV);
  ok(y.length === input.length, `pitch ${st > 0 ? '+' : ''}${st}: length unchanged`);
  ok(Math.abs(cents(f, f0in * Math.pow(2, st / 12))) < 3, `pitch ${st > 0 ? '+' : ''}${st}: f0 ${f.toFixed(1)} Hz, ${cents(f, f0in * Math.pow(2, st / 12)).toFixed(1)} cents from target`);
  // For scale: plain resampling would move them by the full pitch ratio.
  // 10%, not less: above ~200 Hz f0 LPC is pulled toward the nearest
  // harmonic (F1 reads 600 at +7 st, where the harmonics are 630 and 840).
  ok(fmErr(fm, 1) < 0.1, `pitch ${st > 0 ? '+' : ''}${st}: formants kept (F1 ${fm[0]}, F2 ${fm[1]} Hz; resampling would put F1 at ${Math.round(fin[0] * Math.pow(2, st / 12))})`);
  const sl = rms(y, segS) / sin;
  ok(sl > 0.7 && sl < 1.4, `pitch ${st > 0 ? '+' : ''}${st}: the "s" keeps its level (x${sl.toFixed(2)})`);
}
for (const fr of [0.85, 1.2]) {
  const [y] = V.shift([input], SR, { pitch: 0, formant: fr });
  const f = medianF0(y, segV), fm = formants(y, segV);
  ok(y.length === input.length, `formant x${fr}: length unchanged`);
  ok(Math.abs(cents(f, f0in)) < 3, `formant x${fr}: pitch held (${cents(f, f0in).toFixed(1)} cents)`);
  ok(fmErr(fm, fr) < 0.08, `formant x${fr}: F1 ${fm[0]}, F2 ${fm[1]} Hz (x${(fm[0] / fin[0]).toFixed(2)}, x${(fm[1] / fin[1]).toFixed(2)})`);
}
{
  const [y] = V.shift([input], SR, { monotone: 110 });
  ok(Math.abs(medianF0(y, segV) - 110) < 1.5 && f0Spread(y, segV) < 1.5, `robot: monotone at ${medianF0(y, segV).toFixed(1)} Hz, spread ${f0Spread(y, segV).toFixed(2)} Hz (input vibrato ${f0Spread(input, segV).toFixed(2)})`);
}
{
  const st = [input, input.map((v) => v * 0.5)];
  const out = V.shift(st, SR, { pitch: 3 });
  let same = true; for (let i = 0; i < out[0].length; i += 97) if (Math.abs(out[1][i] - out[0][i] * 0.5) > 1e-5) { same = false; break; }
  ok(out.length === 2 && same, 'stereo: both channels cut at the same marks');
}
{
  // A recording with no pauses: the noise floor must not land on the voice.
  // Before the cap this came out unshifted, 400 cents off; 5 is plenty.
  const steady = voice(150, 2.0);
  const [y] = V.shift([steady], SR, { pitch: -4 });
  const want = medianF0(steady, [4410, 83790]) * Math.pow(2, -4 / 12), got = medianF0(y, [4410, 83790]);
  ok(Math.abs(cents(got, want)) < 5, `no pauses: still shifted (${got.toFixed(1)} Hz, ${cents(got, want).toFixed(1)} cents)`);
}
{
  // stretch(): /video-dubbing fits a cloned line to its slot with it.
  const src = voice(150, 2.0);
  const [y] = V.stretch([src], SR, 1 / 1.3);
  const lenOk = Math.abs(y.length - Math.round(src.length / 1.3)) <= 1;
  const c = cents(medianF0(y, [4410, Math.round(y.length - 4410)]), medianF0(src, [4410, src.length - 4410]));
  ok(lenOk && Math.abs(c) < 5, `stretch: 1.3x faster is ${(src.length / y.length).toFixed(3)}x as short, pitch moved ${c.toFixed(1)} cents`);
}
for (const id of Object.keys(V.PRESETS)) {
  if (id === 'custom') continue;
  const y = V.apply([input], SR, V.PRESETS[id]);
  const finite = y[0].every(Number.isFinite), pk = V.peak(y);
  const level = rms(y[0], segV) / rms(input, segV);
  ok(finite && pk <= 0.8913 && level > 0.2 && y[0].length >= input.length, `preset ${id}: peak ${pk.toFixed(3)}, level x${level.toFixed(2)}, ${(y[0].length / SR).toFixed(2)} s`);
}

// Video in, video out, through the real page: a `say` voice on a test
// picture, the Deeper preset. The picture stream must come back copied
// (same codec, same frame count), the length kept, and the voice lower by
// the preset's 4 semitones, within 25 cents through AAC (measured 6). Needs Chrome, macOS say, ffmpeg and the cached
// ffmpeg core (check-fidelity fetches it).
async function browser() {
  const fs = require('fs'), os = require('os'), path = require('path');
  const { execFileSync } = require('child_process');
  const { withPage, findChrome } = require('./chrome-harness');
  const core = path.join(os.homedir(), '.cache', 'audiosaw', 'ffmpeg-core-0.12.6.wasm');
  let tools = true;
  try { execFileSync('say', ['-v', '?'], { stdio: 'ignore' }); execFileSync('ffprobe', ['-version'], { stdio: 'ignore' }); } catch (e) { tools = false; }
  if (!findChrome() || !tools || !fs.existsSync(core)) { console.log('  skip: video test (needs Chrome, say, ffmpeg and the cached ffmpeg core)'); return; }
  console.log('video in, video out');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'as-vc-'));
  execFileSync('say', ['-v', 'Samantha', '-o', path.join(dir, 's.aiff'), 'The keeper lit the lamp at six and climbed the stairs.']);
  const vid = path.join(dir, 'in.mp4');
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=s=320x240:r=25:d=5', '-i', path.join(dir, 's.aiff'),
    '-filter_complex', '[1:a]apad=whole_dur=5[a]', '-map', '0:v', '-map', '[a]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '44100', '-t', '5', vid]);
  await withPage({ routes: { '/__in.mp4': () => fs.readFileSync(vid), '/__core.wasm': () => fs.readFileSync(core) } }, async (page) => {
    page.listen('Fetch.requestPaused', (p) => page.send('Fetch.continueRequest', { requestId: p.requestId, url: page.url('/__core.wasm') }));
    await page.send('Fetch.enable', { patterns: [{ urlPattern: '*ffmpeg-core.wasm*' }] });
    await page.goto('/voice-changer', 1500);
    const r = await page.eval(`(async () => {
      const f = new File([await (await fetch('/__in.mp4')).blob()], 'clip.mp4', { type: 'video/mp4' });
      const dt = new DataTransfer(); dt.items.add(f);
      const inp = document.querySelector('#fileInput'); inp.files = dt.files; inp.dispatchEvent(new Event('change', { bubbles: true }));
      const sel = document.querySelector('#preset'); sel.value = 'deeper'; sel.dispatchEvent(new Event('change'));
      let got = null; const o = CV.downloadBlob; CV.downloadBlob = (b, name) => { got = { b, name }; };
      document.querySelector('#convertBtn').click();
      for (let i = 0; i < 1800 && !got && !/Could not/.test(document.querySelector('#status').textContent); i++) await new Promise((r) => setTimeout(r, 100));
      CV.downloadBlob = o;
      if (!got) return { err: document.querySelector('#status').textContent };
      const u = new Uint8Array(await got.b.arrayBuffer());
      let bin = ''; for (let i = 0; i < u.length; i += 8192) bin += String.fromCharCode.apply(null, u.subarray(i, i + 8192));
      return { name: got.name, type: got.b.type, b64: btoa(bin) };
    })()`, 600000);
    ok(!r.err, 'a video comes back' + (r.err ? ' — ' + r.err : ': ' + r.name + ' (' + r.type + ')'));
    if (r.err) return;
    const out = path.join(dir, 'out.mp4');
    fs.writeFileSync(out, Buffer.from(r.b64, 'base64'));
    const probe = (f) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-count_packets', '-show_streams', '-show_format', '-of', 'json', f], { encoding: 'utf8' }));
    const a = probe(vid), b = probe(out);
    const va = a.streams.find((s) => s.codec_type === 'video'), vb = b.streams.find((s) => s.codec_type === 'video');
    ok(/\.mp4$/.test(r.name) && vb && vb.codec_name === va.codec_name && vb.nb_read_packets === va.nb_read_packets, 'the picture is copied: ' + (vb ? vb.codec_name + ', ' + vb.nb_read_packets + ' frames of ' + va.nb_read_packets : 'no video stream'));
    ok(b.streams.some((s) => s.codec_type === 'audio' && s.codec_name === 'aac') && Math.abs(parseFloat(b.format.duration) - parseFloat(a.format.duration)) < 0.1, 'AAC voice, length kept (' + parseFloat(b.format.duration).toFixed(2) + ' s of ' + parseFloat(a.format.duration).toFixed(2) + ')');
    const pcm = (f) => { const buf = execFileSync('ffmpeg', ['-loglevel', 'error', '-i', f, '-vn', '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-']); return new Float32Array(buf.buffer, buf.byteOffset, buf.length >> 2); };
    const x = pcm(vid), y = pcm(out), win = [Math.round(0.3 * SR), Math.round(2.5 * SR)];
    const c = cents(medianF0(y, win), medianF0(x, win));
    const want = V.PRESETS.deeper.pitch * 100;
    ok(Math.abs(c - want) < 25, 'the voice in the video is lower: ' + c.toFixed(0) + ' cents (the preset asks for ' + want + ')');
  });
}

// The live microphone mode (voice-live.js): getUserMedia is replaced with a
// 200 Hz sawtooth, as the dictation check does with speech. Deeper (-4) must
// record at 158.7 Hz and "no effect" at 200, and the recording must save.
async function live() {
  const { withPage, findChrome } = require('./chrome-harness');
  if (!findChrome()) return;
  console.log('live microphone');
  await withPage({}, async (page) => {
    await page.goto('/voice-changer', 1500);
    const take = (preset) => page.eval(`(async () => {
      navigator.mediaDevices.getUserMedia = async () => {
        const c = new AudioContext(), o = c.createOscillator(), lp = c.createBiquadFilter(), d = c.createMediaStreamDestination();
        o.type = 'sawtooth'; o.frequency.value = 200; lp.frequency.value = 2500; o.connect(lp).connect(d); o.start();
        window.__fakeMic = c; return d.stream;
      };
      const sel = document.querySelector('#livePreset'); sel.value = '${preset}'; sel.dispatchEvent(new Event('change'));
      await window.__voiceLive.start();
      await new Promise((r) => setTimeout(r, 600));
      let saved = null; const o = CV.downloadBlob; CV.downloadBlob = (b, n) => { saved = { size: b.size, n }; };
      window.__voiceLive.startRec();
      await new Promise((r) => setTimeout(r, 2500));
      await window.__voiceLive.stopRec();
      CV.downloadBlob = o;
      window.__voiceLive.stop(); window.__fakeMic.close();
      const L = window.__liveVoice;
      return { saved, sr: L.sampleRate, x: Array.from(L.samples.subarray(Math.round(L.sampleRate * 0.3))) };
    })()`, 120000);
    for (const [preset, st] of [['deeper', -4], ['natural', 0]]) {
      const r = await take(preset), x = Float32Array.from(r.x);
      const fr = P.track(x, r.sr, { minHz: 60, maxHz: 500 }).filter((q) => q.clarity > 0.8).map((q) => q.hz).sort((a, b) => a - b);
      const f0 = fr.length ? fr[fr.length >> 1] : 0, want = 200 * Math.pow(2, st / 12), c = cents(f0, want);
      ok(r.saved && /live-voice-/.test(r.saved.n) && Math.abs(c) < 15 && x.length > r.sr * 1.5, `live ${preset}: ${f0.toFixed(1)} Hz for ${want.toFixed(1)} (${c.toFixed(1)} cents), ${(x.length / r.sr + 0.3).toFixed(1)} s saved as ${r.saved && r.saved.n}`);
    }
    if (page.logs.length) console.log('    console: ' + page.logs.slice(0, 3).join(' | '));
  });
}

browser().then(live).catch((e) => ok(false, 'video/live: ' + (e.stack || e))).then(() => {
  if (failed) { console.log(`\n${failed} check(s) failed`); process.exit(1); }
  console.log('\ncheck-voice: all good');
});
