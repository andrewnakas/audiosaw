#!/usr/bin/env node
/*
 * build-kit.js: the AudioSaw drum kit for /rebirth-player.
 *
 *   node build-kit.js measure REFERENCE.orbkit targets.json
 *   node build-kit.js build targets.json SOURCES_DIR sources.json OUT.orbkit [report.json]
 *
 * "measure" reads a clear kit and writes numbers about each of its 46 slots:
 * length, level, pitch, a third-octave spectrum and a 5 ms level envelope.
 * No audio is written.
 *
 * "build" takes CC0 recordings (sources.json names one or more per slot) and
 * fits each to those numbers: trimmed, re-pitched by resampling, equalised by
 * third-octave band, its decay shaped to the envelope, levelled, cut to
 * length. Every sample in the output comes from the CC0 recordings.
 */
'use strict';
var fs = require('fs');
var path = require('path');
var RS = require(process.env.AS_RESAMPLE || '../../../../js/resample.js');

var R = 44100;
var NAMES = ['BD', 'SD1', 'SD2', 'SD3', 'SD4', 'SD5', 'N1', 'N2', 'N3', 'N4', 'CB', 'CH', 'CL', 'CP', 'CY', 'HC', 'HT', 'LC', 'LT', 'MA', 'MC', 'MT', 'OH', 'RS',
  'Startup', 'bd1', 'bd2', 'bd3', 'bd4', 'sd1', 'sd2', 'sd3', 'sd4', 'sd5', 'sdn1', 'sdn2', 'sdn3', 'lt', 'mt', 'ht', 'rs', 'hc', 'chh', 'ohh', 'ccy', 'rcy'];
var HOP = 220, WIN = 441;                 // envelope: 5 ms hop, 10 ms window
var BANDS = [];
for (var b = -15; b <= 13; b++) BANDS.push(1000 * Math.pow(2, b / 3));   // 31 Hz .. 20 kHz centres

/* ---------- small DSP ---------- */
function fft(re, im, inv) {
  var n = re.length, i, j, k, m;
  for (i = 1, j = 0; i < n; i++) {
    var bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { var t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (m = 2; m <= n; m <<= 1) {
    var ang = (inv ? 2 : -2) * Math.PI / m, wr = Math.cos(ang), wi = Math.sin(ang);
    for (i = 0; i < n; i += m) {
      var cr = 1, ci = 0;
      for (k = 0; k < m / 2; k++) {
        var a = i + k, c = a + m / 2;
        var xr = re[c] * cr - im[c] * ci, xi = re[c] * ci + im[c] * cr;
        re[c] = re[a] - xr; im[c] = im[a] - xi; re[a] += xr; im[a] += xi;
        var nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
  if (inv) for (i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}
function pow2(n) { var p = 1; while (p < n) p <<= 1; return p; }
function spectrum(x) {
  var n = pow2(Math.max(x.length, 4096) * 2), re = new Float64Array(n), im = new Float64Array(n);
  re.set(x); fft(re, im, false);
  return { re: re, im: im, n: n };
}
function bandsOf(x) {
  var s = spectrum(x), out = new Float64Array(BANDS.length), i, k;
  for (k = 1; k < s.n / 2; k++) {
    var f = k * R / s.n, bi = Math.round(3 * Math.log2(f / 1000)) + 15;
    if (bi < 0 || bi >= BANDS.length) continue;
    out[bi] += s.re[k] * s.re[k] + s.im[k] * s.im[k];
  }
  for (i = 0; i < out.length; i++) out[i] = out[i] / s.n * 2;     // energy, same scale for any padding
  return out;
}
// Zero-phase filter: gain(f) applied to the whole sample.
function shape(x, gain) {
  var s = spectrum(x), k;
  for (k = 0; k <= s.n / 2; k++) {
    var g = gain(k * R / s.n);
    s.re[k] *= g; s.im[k] *= g;
    if (k && k < s.n / 2) { s.re[s.n - k] *= g; s.im[s.n - k] *= g; }
  }
  fft(s.re, s.im, true);
  return Float64Array.from(s.re.subarray(0, x.length));
}
function envOf(x) {
  var n = Math.max(1, Math.ceil(x.length / HOP)), e = new Float64Array(n);
  for (var i = 0; i < n; i++) {
    var a = Math.max(0, i * HOP - (WIN - HOP) / 2 | 0), bEnd = Math.min(x.length, a + WIN), s = 0;
    for (var j = a; j < bEnd; j++) s += x[j] * x[j];
    e[i] = Math.sqrt(s / Math.max(1, bEnd - a));
  }
  return e;
}
function rms(x) { var s = 0; for (var i = 0; i < x.length; i++) s += x[i] * x[i]; return Math.sqrt(s / Math.max(1, x.length)); }
function peak(x) { var p = 0; for (var i = 0; i < x.length; i++) if (Math.abs(x[i]) > p) p = Math.abs(x[i]); return p; }
// Pitch by autocorrelation of a low-passed copy, 5 ms in, up to 150 ms.
function f0Of(x, lo, hi) {
  lo = lo || 35; hi = hi || 1500;
  var y = shape(x, function (f) { return f < hi * 1.5 ? 1 : 0; });
  var a = Math.min(220, y.length >> 2), n = Math.min(y.length - a, 8820);
  if (n < 400) { a = 0; n = y.length; }
  var best = 0, bestLag = 0, e0 = 0, i, lag, scores = [];
  for (i = 0; i < n; i++) e0 += y[a + i] * y[a + i];
  var minLag = Math.floor(R / hi), maxLag = Math.min(Math.floor(R / lo), n - 50);
  for (lag = minLag; lag <= maxLag; lag++) {
    var s = 0, e1 = 0, e2 = 0;
    for (i = 0; i + lag < n; i++) { s += y[a + i] * y[a + i + lag]; e1 += y[a + i] * y[a + i]; e2 += y[a + i + lag] * y[a + i + lag]; }
    var c = s / Math.sqrt(e1 * e2 + 1e-30);
    scores[lag] = c;
    if (c > best) { best = c; bestLag = lag; }
  }
  // skip the fall from lag 0, then take the first peak within 90% of the best after it
  var start = minLag + 1;
  while (start < maxLag && !(scores[start] < 0.3 && scores[start] <= scores[start + 1])) start++;
  best = 0; bestLag = 0;
  for (lag = start; lag < maxLag; lag++) if (scores[lag] > best) { best = scores[lag]; bestLag = lag; }
  if (!bestLag || best < 0.3) return { hz: 0, conf: best };
  for (lag = start + 1; lag < bestLag; lag++) {
    if (scores[lag] > 0.9 * best && scores[lag] >= scores[lag - 1] && scores[lag] >= scores[lag + 1]) { bestLag = lag; break; }
  }
  var p = scores[bestLag - 1] || 0, q = scores[bestLag], r2 = scores[bestLag + 1] || 0, d = (p - r2) / (2 * (p - 2 * q + r2) || 1);
  return { hz: R / (bestLag + (isFinite(d) ? Math.max(-0.5, Math.min(0.5, d)) : 0)), conf: best };
}
function trimStart(x) {
  var p = peak(x), i = 0;
  while (i < x.length && Math.abs(x[i]) < p * 0.01) i++;
  i = Math.max(0, i - 8);
  return x.subarray(i);
}
function repitch(x, ratio) {
  if (Math.abs(ratio - 1) < 0.002) return Float64Array.from(x);
  return Float64Array.from(RS.channel(Float32Array.from(x), Math.round(R * ratio * 4), R * 4));
}
function rand(seed) { var s = seed >>> 0; return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
// The same magnitude spectrum with new phases: another burst of the same noise.
function rephase(x, seed) {
  var s = spectrum(x), rnd = rand(seed), k;
  for (k = 1; k < s.n / 2; k++) {
    var m = Math.hypot(s.re[k], s.im[k]), ph = 2 * Math.PI * rnd();
    s.re[k] = m * Math.cos(ph); s.im[k] = m * Math.sin(ph);
    s.re[s.n - k] = s.re[k]; s.im[s.n - k] = -s.im[k];
  }
  fft(s.re, s.im, true);
  return Float64Array.from(s.re.subarray(0, x.length));
}
function db(x) { return 20 * Math.log10(x + 1e-12); }

/* ---------- files ---------- */
function readKit(file) {
  var b = fs.readFileSync(file), p = 8, n = b.readUInt16LE(p), slots = [];
  p += 2 + n;
  for (var s = 0; s < 46; s++) {
    var f = b.readUInt32LE(p); p += 4;
    if (f === 0xFFFFFFFF) { slots.push(null); continue; }
    var x = new Float64Array(f);
    for (var i = 0; i < f; i++) x[i] = b.readInt16LE(p + 2 * i) / 32768;
    p += 2 * f; slots.push(x);
  }
  return slots;
}
function writeKit(file, name, slots) {
  var nb = Buffer.from(name, 'utf8'), parts = [Buffer.from('ORBKIT1\0', 'latin1'), Buffer.alloc(2)];
  parts[1].writeUInt16LE(nb.length, 0); parts.push(nb);
  slots.forEach(function (x) {
    var h = Buffer.alloc(4), d = Buffer.alloc(x.length * 2);
    h.writeUInt32LE(x.length, 0);
    for (var i = 0; i < x.length; i++) d.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x[i] * 32767))), i * 2);
    parts.push(h, d);
  });
  fs.writeFileSync(file, Buffer.concat(parts));
}
function readWav(file) {
  var b = fs.readFileSync(file), p = 12, fmt = null;
  while (p + 8 <= b.length) {
    var id = b.toString('latin1', p, p + 4), len = b.readUInt32LE(p + 4);
    if (id === 'fmt ') fmt = { tag: b.readUInt16LE(p + 8), ch: b.readUInt16LE(p + 10), rate: b.readUInt32LE(p + 12), bits: b.readUInt16LE(p + 22) };
    if (id === 'data') {
      if (len > b.length - p - 8) len = b.length - p - 8;
      if (!fmt || fmt.ch !== 1 || fmt.rate !== R) throw new Error(file + ': want 44.1 kHz mono');
      var n, x, i;
      if (fmt.bits === 32 && fmt.tag === 3) { n = len >> 2; x = new Float64Array(n); for (i = 0; i < n; i++) x[i] = b.readFloatLE(p + 8 + 4 * i); }
      else if (fmt.bits === 16) { n = len >> 1; x = new Float64Array(n); for (i = 0; i < n; i++) x[i] = b.readInt16LE(p + 8 + 2 * i) / 32768; }
      else if (fmt.bits === 24) { n = Math.floor(len / 3); x = new Float64Array(n); for (i = 0; i < n; i++) x[i] = b.readIntLE(p + 8 + 3 * i, 3) / 8388608; }
      else throw new Error(file + ': unsupported WAV');
      return x;
    }
    p += 8 + len + (len & 1);
  }
  throw new Error(file + ': no audio');
}

/* ---------- measure ---------- */
function measure(refFile, outFile) {
  var slots = readKit(refFile), out = {};
  slots.forEach(function (x, i) {
    var name = NAMES[i];
    if (!x) { out[name] = null; return; }
    var f = f0Of(x);
    out[name] = {
      frames: x.length, rms: +rms(x).toPrecision(5), peak: +peak(x).toPrecision(4), f0: +f.hz.toFixed(2), f0conf: +f.conf.toFixed(3),
      bands: Array.from(bandsOf(x)).map(function (v) { return +(10 * Math.log10(v + 1e-15)).toFixed(1); }),
      env: Array.from(envOf(x)).map(function (v) { return +db(v).toFixed(1); })
    };
  });
  fs.writeFileSync(outFile, JSON.stringify(out));
  console.log(outFile + ': ' + Object.keys(out).length + ' slots');
}

/* ---------- build ---------- */
function fit(x, t, o) {
  o = o || {};
  var note = {}, i;
  x = Float64Array.from(trimStart(x));
  // pitch
  if (o.ratio) { x = repitch(x, o.ratio); note.ratio = o.ratio; }
  else if (o.pitch && t.f0 > 0) {
    var f = o.srcF0 || f0Of(x).hz;
    if (f > 0) {
      var ratio = t.f0 / f;
      note.srcF0 = +f.toFixed(1); note.ratio = +ratio.toFixed(3);
      if (ratio > 0.4 && ratio < 2.5) x = repitch(x, ratio);
    }
  }
  // spectrum, by third-octave band
  var tb = t.bands, sb = Array.from(bandsOf(x)).map(function (v) { return 10 * Math.log10(v + 1e-15); });
  var tTot = -200, sTot = -200;
  tb.forEach(function (v) { tTot = Math.max(tTot, v); }); sb.forEach(function (v) { sTot = Math.max(sTot, v); });
  var lim = o.eqLimit == null ? 12 : o.eqLimit;
  var g = tb.map(function (v, k) {
    var d = (v - tTot) - (sb[k] - sTot);
    if (sb[k] - sTot < -60) d = Math.min(d, 0);          // nothing there to raise
    if (v - tTot < -70) d = Math.min(d, 0);
    return Math.max(-24, Math.min(lim, d));
  });
  var before = 0, wsum = 0;
  tb.forEach(function (v, k) { var w = Math.pow(10, (v - tTot) / 20); before += w * Math.abs((v - tTot) - (sb[k] - sTot)); wsum += w; });
  note.specBefore = +(before / wsum).toFixed(1);
  var gs = g.map(function (v, k) { return (g[Math.max(0, k - 1)] + 2 * v + g[Math.min(g.length - 1, k + 1)]) / 4; });
  x = shape(x, function (fr) {
    if (fr < 15) return 0;
    var pos = 3 * Math.log2(fr / 1000) + 15, a = Math.max(0, Math.min(gs.length - 1, Math.floor(pos))), c = Math.min(gs.length - 1, a + 1), u = Math.max(0, Math.min(1, pos - a));
    return Math.pow(10, (gs[a] * (1 - u) + gs[c] * u) / 20);
  });
  // length and decay
  var y = new Float64Array(t.frames);
  y.set(x.subarray(0, Math.min(x.length, t.frames)));
  var se = envOf(y), te = t.env, sPk = -200, tPk = -200;
  for (i = 0; i < se.length; i++) sPk = Math.max(sPk, db(se[i]));
  for (i = 0; i < te.length; i++) tPk = Math.max(tPk, te[i]);
  var up = o.envUp == null ? 12 : o.envUp, eg = new Float64Array(se.length);
  for (i = 0; i < se.length; i++) {
    var d = ((te[i] == null ? -200 : te[i]) - tPk) - (db(se[i]) - sPk);
    if (db(se[i]) - sPk < -66) d = Math.min(d, 0);
    eg[i] = Math.max(-60, Math.min(up, d));
  }
  for (var pass = 0; pass < 2; pass++) { var c2 = Float64Array.from(eg); for (i = 0; i < eg.length; i++) eg[i] = (c2[Math.max(0, i - 1)] + 2 * c2[i] + c2[Math.min(eg.length - 1, i + 1)]) / 4; }
  if (!o.noEnv) for (i = 0; i < y.length; i++) {
    var pos = i / HOP, a = Math.min(eg.length - 1, Math.floor(pos)), c = Math.min(eg.length - 1, a + 1), u = pos - a;
    y[i] *= Math.pow(10, (eg[a] * (1 - u) + eg[c] * u) / 20);
  }
  // level
  var k = t.rms / (rms(y) + 1e-12);
  for (i = 0; i < y.length; i++) y[i] *= k;
  var pk = peak(y);
  if (pk > 0.985) { for (i = 0; i < y.length; i++) y[i] *= 0.985 / pk; note.peakLimited = +db(0.985 / pk).toFixed(1); }
  var fade = Math.min(132, y.length >> 2);
  for (i = 0; i < fade; i++) y[y.length - 1 - i] *= i / fade;
  // how close
  var ob = Array.from(bandsOf(y)).map(function (v) { return 10 * Math.log10(v + 1e-15); }), oTot = -200, after = 0;
  ob.forEach(function (v) { oTot = Math.max(oTot, v); });
  tb.forEach(function (v, kk) { var w = Math.pow(10, (v - tTot) / 20); after += w * Math.abs((v - tTot) - (ob[kk] - oTot)); });
  note.specAfter = +(after / wsum).toFixed(1);
  var oe = envOf(y), es = 0, en = 0;
  for (i = 0; i < oe.length && i < te.length; i++) if (te[i] > tPk - 40) { es += Math.abs(db(oe[i]) - te[i]); en++; }
  note.envErr = +(es / Math.max(1, en)).toFixed(1);
  if (o.pitch) note.f0 = +f0Of(y).hz.toFixed(1), note.want = t.f0;
  note.peak = +peak(y).toFixed(3);
  return { audio: y, note: note };
}

function build(targetsFile, dir, sourcesFile, outFile, reportFile) {
  var T = JSON.parse(fs.readFileSync(targetsFile, 'utf8')), S = JSON.parse(fs.readFileSync(sourcesFile, 'utf8'));
  var cache = {};
  function load(f) { return cache[f] || (cache[f] = readWav(path.join(dir, f + '.wav'))); }
  var slots = [], report = {};
  NAMES.forEach(function (name, idx) {
    var t = T[name], rec = S.slots[name];
    if (!rec || !t) { slots.push(new Float64Array(64)); report[name] = { source: 'silence' }; return; }
    var best = null;
    rec.from.forEach(function (file) {
      var x = load(file), o = Object.assign({}, rec);
      if (rec.part) {
        // a snare is two samples here: the drum's tone, and the noise above it
        var cut = rec.split || 700;
        var lowpass = function (f) { return f <= cut * 0.7 ? 1 : f >= cut * 1.4 ? 0 : 0.5 + 0.5 * Math.cos(Math.PI * Math.log(f / (cut * 0.7)) / Math.log(2)); };
        x = trimStart(x);
        x = rec.part === 'tone' ? shape(x, lowpass) : shape(x, function (f) { return 1 - lowpass(f); });
        if (rec.part === 'noise' && rec.seed) x = rephase(x, rec.seed + idx);
      }
      var r = fit(x, t, o);
      r.note.source = file;
      var score = r.note.specAfter + r.note.envErr;
      if (!best || score < best.score) best = { r: r, score: score };
    });
    slots.push(best.r.audio); report[name] = best.r.note;
  });
  writeKit(outFile, S.name, slots);
  if (reportFile) fs.writeFileSync(reportFile, JSON.stringify(report, null, 1));
  console.log(outFile + ': ' + fs.statSync(outFile).size + ' bytes');
  NAMES.forEach(function (n) { var r = report[n]; console.log(n.padEnd(8), JSON.stringify(r)); });
}

var a = process.argv.slice(2);
if (a[0] === 'measure' && a.length === 3) measure(a[1], a[2]);
else if (a[0] === 'build' && a.length >= 5) build(a[1], a[2], a[3], a[4], a[5]);
else { console.error('usage: build-kit.js measure REF.orbkit targets.json | build targets.json SRC_DIR sources.json OUT.orbkit [report.json]'); process.exit(2); }
