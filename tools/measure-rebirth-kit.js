#!/usr/bin/env node
/*
 * How close the built-in kit of /rebirth-player is to ReBirth's own, on real
 * songs. Not in check-all: it needs the reference kit and songs, neither of
 * which is in this repository.
 *
 *   node tools/measure-rebirth-kit.js Standard.orbkit vendor/openrb/2026-11-13/kit/audiosaw-kit-1.orbkit SONGS_DIR [30]
 *
 * Each song is rendered three ways (no kit, the reference, ours; 30 s). The
 * drum part is a render with a kit minus the render without. Reported per
 * song and as medians: the level difference, the difference by octave band
 * weighted by the reference's own balance, and the correlation of the two
 * 10 ms loudness curves. 13 Nov 2026, 30 songs: level 0.00 dB (worst 0.90),
 * bands 0.28 dB (worst 1.41), envelope 0.998 (worst 0.786).
 */
const fs = require('fs'), path = require('path');
const REPO = path.join(__dirname, '..');
const A = require(REPO + '/js/rebirth-play.js');
const [refKit, newKit, dir, nStr] = process.argv.slice(2);
const N = +nStr || 40;
function rmsdb(x) { let s = 0; for (let i = 0; i < x.length; i++) s += x[i] * x[i]; return 10 * Math.log10(s / x.length + 1e-20); }
function env(x) { const h = 441, o = []; for (let i = 0; i + h <= x.length; i += h) { let s = 0; for (let j = i; j < i + h; j++) s += x[j] * x[j]; o.push(Math.sqrt(s / h)); } return o; }
function corr(a, b) { const n = Math.min(a.length, b.length); let ma = 0, mb = 0; for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; } ma /= n; mb /= n; let s = 0, sa = 0, sb = 0; for (let i = 0; i < n; i++) { s += (a[i] - ma) * (b[i] - mb); sa += (a[i] - ma) ** 2; sb += (b[i] - mb) ** 2; } return s / Math.sqrt(sa * sb + 1e-30); }
function bands(x) { // octave bands by Goertzel-free filterbank: FFT of 2^17 chunks
  const n = 1 << 16, out = new Float64Array(10); let frames = 0;
  for (let off = 0; off + n <= x.length; off += n) {
    const re = Float64Array.from(x.subarray(off, off + n)), im = new Float64Array(n);
    for (let i = 0; i < n; i++) re[i] *= 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n);
    fft(re, im);
    for (let k = 1; k < n / 2; k++) { const f = k * 44100 / n, b = Math.floor(Math.log2(f / 22.1)); if (b >= 0 && b < 10) out[b] += re[k] * re[k] + im[k] * im[k]; }
    frames++;
  }
  return Array.from(out).map(v => 10 * Math.log10(v / Math.max(1, frames) + 1e-20));
}
function fft(re, im) { const n = re.length; for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
  for (let m = 2; m <= n; m <<= 1) { const ang = -2 * Math.PI / m, wr = Math.cos(ang), wi = Math.sin(ang); for (let i = 0; i < n; i += m) { let cr = 1, ci = 0; for (let k = 0; k < m / 2; k++) { const a = i + k, c = a + m / 2; const xr = re[c] * cr - im[c] * ci, xi = re[c] * ci + im[c] * cr; re[c] = re[a] - xr; im[c] = im[a] - xi; re[a] += xr; im[a] += xi; const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr; } } } }
const med = a => { const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };
A.load(REPO + '/vendor/openrb/2026-11-13/openrb.wasm').then(() => {
  const ref = new Uint8Array(fs.readFileSync(refKit)), mine = new Uint8Array(fs.readFileSync(newKit));
  const files = fs.readdirSync(dir).filter(f => /\.rbs$/i.test(f)).sort();
  const step = Math.floor(files.length / (N * 2)); const rows = [];
  for (let i = 0; i < files.length && rows.length < N; i += step) {
    let b; try { b = new Uint8Array(fs.readFileSync(path.join(dir, files[i]))); } catch (e) { continue; }
    let r0, r1, r2;
    try { r0 = A.render(b, { maxSeconds: 30 }); if (!r0.drumsSilent || r0.modMissing) continue; r1 = A.render(b, { kit: ref, maxSeconds: 30 }); r2 = A.render(b, { kit: mine, maxSeconds: 30 }); } catch (e) { continue; }
    const n = Math.min(r0.channels[0].length, r1.channels[0].length, r2.channels[0].length);
    const d1 = new Float64Array(n), d2 = new Float64Array(n), m1 = new Float64Array(n), m2 = new Float64Array(n);
    for (let k = 0; k < n; k++) { const z = r0.channels[0][k] + r0.channels[1][k]; m1[k] = r1.channels[0][k] + r1.channels[1][k]; m2[k] = r2.channels[0][k] + r2.channels[1][k]; d1[k] = m1[k] - z; d2[k] = m2[k] - z; }
    if (rmsdb(d1) < -60) continue;        // the drums never hit
    const b1 = bands(d1), b2 = bands(d2), top = Math.max(...b1); let be = 0, bw = 0;
    b1.forEach((v, k) => { const w = Math.pow(10, (v - top) / 20); be += w * Math.abs(v - b2[k]); bw += w; });
    rows.push({ f: files[i], mix: rmsdb(m2) - rmsdb(m1), drums: rmsdb(d2) - rmsdb(d1), band: be / bw, env: corr(env(d1), env(d2)), peak1: r1.peak, peak2: r2.peak, bd: b2.map((v, k) => (v - b1[k]).toFixed(1)).join(' ') });
    const r = rows[rows.length - 1];
    console.log(r.f.slice(0, 28).padEnd(28), 'mix', r.mix.toFixed(2), 'drums', r.drums.toFixed(2), 'bandErr', r.band.toFixed(2), 'env', r.env.toFixed(3), '|', r.bd);
  }
  console.log('\n' + rows.length + ' songs. median: mix level ' + med(rows.map(r => r.mix)).toFixed(2) + ' dB, drum level ' + med(rows.map(r => r.drums)).toFixed(2) + ' dB, band error ' + med(rows.map(r => r.band)).toFixed(2) + ' dB, envelope corr ' + med(rows.map(r => r.env)).toFixed(3));
  console.log('worst: drum level ' + Math.max(...rows.map(r => Math.abs(r.drums))).toFixed(2) + ' dB, band ' + Math.max(...rows.map(r => r.band)).toFixed(2) + ' dB, env ' + Math.min(...rows.map(r => r.env)).toFixed(3));
  const o = {}; for (let k = 0; k < 10; k++) o[k] = med(rows.map(r => +r.bd.split(' ')[k])); console.log('median per-octave difference (22 Hz up):', Object.values(o).join(' '));
});
