#!/usr/bin/env node
/*
 * Checks /fake-lossless-detector and /audio-file-info (js/audio-inspect.js +
 * js/inspect-page.js).
 *
 * Fixture: 30 s of full-band "music" at 44.1 kHz (chords with 20 harmonics,
 * a cymbal of noise on every beat, a -75 dB floor), encoded with the local
 * ffmpeg's LAME and AAC and decoded back, as a transcode to FLAC or WAV
 * would be. Prints where each encoder leaves its edge (the numbers behind
 * ASInspect.SIGNATURES) and requires:
 *   - the original, and a dark recording that fades out gradually, read as
 *     genuine;
 *   - LAME 96-256 kbps CBR, V2, and AAC 128 read as a lossy source, each
 *     named by the bitrate that made it;
 *   - LAME 320 reads as "can't tell", never as fake;
 *   - LAME V0 and AAC 256 keep the whole band here: reported, not required;
 *   - a 96 kHz file made from the 44.1 kHz one reads as upsampled, and a
 *     real 96 kHz one (noise to 48 kHz) does not;
 *   - bitsUsed finds 16-bit audio in a 24-bit file, on both of Chrome's
 *     16-bit grids.
 * Browser: both pages on real files: a FLAC transcoded from a 128 kbps MP3,
 * a padded 24-bit WAV and the genuine FLAC; and the info page against
 * ffprobe (rate, channels, duration), ffmpeg's ebur128 (within 0.1 LU, true
 * peak within 0.3 dB) and a WAV with exactly 3 clipped runs.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const I = require('../js/audio-inspect.js');

let failed = 0;
const ok = (c, m) => { console.log((c ? '  ok  ' : '  FAIL ') + m); if (!c) failed++; };
const ff = (args, input) => execFileSync('ffmpeg', ['-loglevel', 'error', '-y'].concat(args), { input, maxBuffer: 1 << 28 });
function rnd(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

function fullBand(R, sec, dark) {
  const n = sec * R, L = new Float32Array(n), Rr = new Float32Array(n), r = rnd(5);
  const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);
  for (let b = 0; b * 0.5 < sec; b++) {
    const s0 = Math.round(b * 0.5 * R), notes = [60, 64, 67, 71].map((m) => m + (b % 4) * 2);
    notes.forEach((m, j) => {
      const f = hz(m);
      for (let i = 0; i < R && s0 + i < n; i++) {
        const t = i / R, e = Math.exp(-t * 3) * Math.min(1, t / 0.005) * Math.min(1, (R - i) / (0.2 * R));
        let v = 0; for (let h = 1; h <= 20 && f * h < R / 2; h++) v += Math.sin(2 * Math.PI * f * h * t + h * j) / (dark ? h * h * h : h);
        L[s0 + i] += 0.03 * e * v; Rr[s0 + i] += 0.025 * e * v;
      }
    });
    if (!dark) {
      let hp = 0, prev = 0;
      for (let i = 0; i < 0.4 * R && s0 + i < n; i++) { const t = i / R, w = r() - 0.5; hp = 0.7 * (hp + w - prev); prev = w; const e = 0.15 * Math.exp(-t * 8) * Math.min(1, (0.4 * R - i) / (0.1 * R)); L[s0 + i] += e * hp; Rr[s0 + i] += e * (r() - 0.5) * 0.8; }
    }
  }
  const fl = dark ? 0.00002 : 0.0002;
  for (let i = 0; i < n; i++) { L[i] += fl * (r() - 0.5); Rr[i] += fl * (r() - 0.5); }
  return [L, Rr];
}
function interleave(ch) { const n = ch[0].length, x = new Float32Array(n * ch.length); for (let i = 0; i < n; i++) for (let c = 0; c < ch.length; c++) x[i * ch.length + c] = ch[c][i]; return Buffer.from(x.buffer); }
function decode(f) { const raw = ff(['-i', f, '-ac', '2', '-f', 'f32le', '-']); const x = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4), n = x.length / 2, L = new Float32Array(n), R = new Float32Array(n); for (let i = 0; i < n; i++) { L[i] = x[2 * i]; R[i] = x[2 * i + 1]; } return [L, R]; }
function rateOf(f) { return +execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=sample_rate', '-of', 'csv=p=0', f]).toString().trim(); }
function judge(f, info) { const ch = decode(f), rate = rateOf(f), sp = I.spectrum(ch, rate), c = I.cutoff(sp); return { c, v: I.verdict(info || { lossless: true, container: 'flac' }, sp, c, null) }; }

async function main() {
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); } catch (e) { console.log('  skip: needs ffmpeg'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'as-inspect-'));
  const p = (f) => path.join(dir, f);
  ff(['-f', 'f32le', '-ar', '44100', '-ac', '2', '-i', '-', '-c:a', 'pcm_s16le', p('full.wav')], interleave(fullBand(44100, 30)));
  ff(['-f', 'f32le', '-ar', '44100', '-ac', '2', '-i', '-', '-c:a', 'pcm_s16le', p('dark.wav')], interleave(fullBand(44100, 30, true)));
  const enc = [['mp3_96', ['-c:a', 'libmp3lame', '-b:a', '96k'], 'mp3'], ['mp3_128', ['-c:a', 'libmp3lame', '-b:a', '128k'], 'mp3'], ['mp3_160', ['-c:a', 'libmp3lame', '-b:a', '160k'], 'mp3'],
    ['mp3_192', ['-c:a', 'libmp3lame', '-b:a', '192k'], 'mp3'], ['mp3_256', ['-c:a', 'libmp3lame', '-b:a', '256k'], 'mp3'], ['mp3_320', ['-c:a', 'libmp3lame', '-b:a', '320k'], 'mp3'],
    ['mp3_v2', ['-c:a', 'libmp3lame', '-q:a', '2'], 'mp3'], ['mp3_v0', ['-c:a', 'libmp3lame', '-q:a', '0'], 'mp3'], ['aac_128', ['-c:a', 'aac', '-b:a', '128k'], 'm4a'], ['aac_256', ['-c:a', 'aac', '-b:a', '256k'], 'm4a']];
  console.log('core: where each encoder leaves its edge (44.1 kHz)');
  const g = {};
  for (const [name, args, ext] of enc) {
    ff(['-i', p('full.wav')].concat(args, [p(name + '.' + ext)]));
    ff(['-i', p(name + '.' + ext), '-c:a', 'flac', p(name + '.flac')]);   // the transcode
    g[name] = judge(p(name + '.flac'));
    console.log('       ' + name.padEnd(8) + (g[name].c.sharp ? 'edge at ' + (g[name].c.hz / 1000).toFixed(2) + ' kHz, ' + g[name].c.drop.toFixed(0) + ' dB' : 'no edge') + ' -> ' + g[name].v[0].grade + (g[name].v[0].grade === 'lossy-source' ? ' (' + /most like ([^.]+)\./.exec(g[name].v[0].detail)[1] + ')' : ''));
  }
  const full = judge(p('full.wav')), dark = judge(p('dark.wav'));
  ok(full.v[0].grade === 'genuine' && dark.v[0].grade === 'genuine', 'the original (' + full.v[0].title.toLowerCase() + ') and a dark recording that fades out by ' + (dark.c.hz / 1000).toFixed(1) + ' kHz read as genuine');
  const want = { mp3_96: '96 kbps', mp3_128: '128 kbps MP3', mp3_160: '160 kbps', mp3_192: '192 kbps', mp3_256: '256 kbps', mp3_v2: 'V2', aac_128: '128 kbps AAC' };
  const wrong = Object.keys(want).filter((k) => g[k].v[0].grade !== 'lossy-source' || g[k].v[0].detail.indexOf(want[k]) < 0);
  ok(!wrong.length, 'LAME 96, 128, 160, 192, 256, V2 and AAC 128, transcoded to FLAC: each a lossy source, named by its bitrate' + (wrong.length ? ' (wrong: ' + wrong.join(', ') + ')' : ''));
  ok(g.mp3_320.v[0].grade === 'unclear', 'LAME 320: "' + g.mp3_320.v[0].title + '", never called fake');
  console.log('       (LAME V0: ' + g.mp3_v0.v[0].grade + ', AAC 256: ' + g.aac_256.v[0].grade + ' - they kept the whole band; the page says this is not caught)');
  // 96 kHz: upsampled from the CD file, and a real one with noise to 48 kHz.
  ff(['-i', p('full.wav'), '-af', 'aresample=96000:filter_size=64', '-c:a', 'pcm_s24le', p('up96.wav')]);
  const real96 = fullBand(96000, 10); const r = rnd(9); real96.forEach((c) => { for (let i = 0; i < c.length; i++) c[i] += 0.001 * (r() - 0.5); });
  ff(['-f', 'f32le', '-ar', '96000', '-ac', '2', '-i', '-', '-c:a', 'pcm_s24le', p('real96.wav')], interleave(real96));
  const u = judge(p('up96.wav')), rr = judge(p('real96.wav'));
  ok(u.v[0].grade === 'upsampled' && rr.v[0].grade === 'genuine', '96 kHz made from 44.1: "' + u.v[0].title + '"; a real 96 kHz file: ' + rr.v[0].grade);
  {
    const a = new Float32Array(4000).map((_, i) => Math.round(Math.sin(i * 0.37) * 30000) * 256 / 8388608);
    const b = new Float32Array(4000).map((_, i) => { const n = Math.round(Math.sin(i * 0.37) * 30000); return n > 0 ? n / 32767 : n / 32768; });
    const c = new Float32Array(4000).map((_, i) => Math.round(Math.sin(i * 0.37) * 8000000) / 8388608);
    const x = I.bitsUsed([a], 24), y = I.bitsUsed([b], 16), z = I.bitsUsed([c], 24);
    ok(x.used === 16 && y.used === 16 && z.used === 24, 'bits in use: 16 of 24 when padded, 16 of 16 on Chrome\'s asymmetric grid, 24 of 24 when real');
  }

  const { withPage, findChrome } = require('./chrome-harness');
  if (!findChrome()) { console.log('  skip: pages (no Chrome)'); return; }
  console.log('pages');
  ff(['-i', p('full.wav'), '-c:a', 'pcm_s24le', p('padded24.wav')]);
  ff(['-i', p('full.wav'), '-c:a', 'flac', p('genuine.flac')]);
  // Exactly three clipped runs (of 5, 9 and 3 samples) in a 24-bit WAV.
  const cl = fullBand(48000, 12); [[1.0, 5], [4.5, 9], [8.25, 3]].forEach(([t, k]) => { for (let i = 0; i < k; i++) { cl[0][Math.round(t * 48000) + i] = 1; } });
  ff(['-f', 'f32le', '-ar', '48000', '-ac', '2', '-i', '-', '-c:a', 'pcm_s24le', p('clipped.wav')], interleave(cl));
  const load = (names) => names.map((n) => [n, fs.readFileSync(p(n)).toString('base64')]);
  const run = (page, names) => page.eval(`(async () => {
    const fs = ${JSON.stringify(load(names))}.map(([n, b]) => { const bin = atob(b); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new File([u], n); });
    window.__inspect.use(fs);
    for (let i = 0; i < 600 && window.__inspect.rows().length < fs.length && !/error/.test(document.getElementById('status').className); i++) await new Promise((r) => setTimeout(r, 200));
    return { rows: window.__inspect.rows().map((r) => ({ name: r.file.name, grades: r.verdicts.map((v) => v.grade), titles: r.verdicts.map((v) => v.title), lufs: r.lufs, tp: r.truePeak, clips: r.stats && r.stats.clips, rate: r.rate, ch: r.channels, dur: r.duration, fields: window.__inspect.fields(r) })), status: document.getElementById('status').textContent, cards: document.querySelectorAll('.inspect-card canvas').length };
  })()`, 300000);
  await withPage({}, async (page) => {
    await page.goto('/fake-lossless-detector', 1500);
    const r = await run(page, ['mp3_128.flac', 'padded24.wav', 'genuine.flac']);
    const by = Object.fromEntries(r.rows.map((x) => [x.name, x]));
    ok(r.rows.length === 3 && r.cards === 3, 'three files read, three spectra drawn (' + r.status + ')');
    ok(by['mp3_128.flac'] && by['mp3_128.flac'].grades[0] === 'lossy-source', 'the FLAC made from a 128 kbps MP3: "' + (by['mp3_128.flac'] || {}).titles + '"');
    ok(by['padded24.wav'] && by['padded24.wav'].grades.indexOf('padded') >= 0, 'the 24-bit WAV made from 16-bit: "' + (by['padded24.wav'] || {}).titles + '"');
    ok(by['genuine.flac'] && by['genuine.flac'].grades.join() === 'genuine', 'the genuine FLAC: "' + (by['genuine.flac'] || {}).titles + '"');
    await page.goto('/audio-file-info', 1500);
    const q = await run(page, ['clipped.wav', 'mp3_v0.mp3']);
    const c = q.rows[0], m = q.rows[1];
    const probe = (f, e) => execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', e, '-of', 'csv=p=0', p(f)]).toString().trim().split(',');
    const [prate, pch] = probe('clipped.wav', 'stream=sample_rate,channels'), pdur = +probe('clipped.wav', 'format=duration')[0];
    const eb = execFileSync('ffmpeg', ['-nostats', '-i', p('clipped.wav'), '-af', 'ebur128=peak=true', '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'pipe'] }).toString() + '';
    let ebOut = ''; try { ebOut = execFileSync('sh', ['-c', 'ffmpeg -nostats -i "' + p('clipped.wav') + '" -af ebur128=peak=true -f null - 2>&1']).toString(); } catch (e) { ebOut = String(e.stdout || ''); }
    const I0 = +/I:\s+(-?[\d.]+) LUFS/.exec(ebOut.split('Summary:')[1])[1], TP = +/Peak:\s+(-?[\d.]+) dBFS/.exec(ebOut.split('True peak:')[1])[1];
    ok(c && c.rate === +prate && c.ch === +pch && Math.abs(c.dur - pdur) < 0.01, 'info: ' + c.rate + ' Hz, ' + c.ch + ' channels, ' + c.dur.toFixed(3) + ' s, as ffprobe reads it');
    ok(c && Math.abs(c.lufs - I0) <= 0.1 && Math.abs(c.tp - TP) <= 0.3, 'info: ' + c.lufs.toFixed(1) + ' LUFS and ' + c.tp.toFixed(1) + ' dBTP; ebur128 says ' + I0.toFixed(1) + ' and ' + TP.toFixed(1));
    ok(c && c.clips === 3, 'info: ' + c.clips + ' clipped runs found (3 written)');
    const f = Object.fromEntries((m || { fields: [] }).fields);
    ok(m && /VBR/.test(f.Bitrate) && /LAME/.test(f.Bitrate), 'info: the V0 MP3 reads "' + f.Bitrate + '"');
    const errs = page.logs.filter((l) => !/scriptwrapper|ERR_CONNECTION_REFUSED|favicon/.test(l));
    ok(!errs.length, 'no page errors' + (errs.length ? ': ' + errs.join(' | ').slice(0, 300) : ''));
  });
}

main().then(() => {
  if (failed) { console.log('\ncheck-inspect: ' + failed + ' failed'); process.exit(1); }
  console.log('\ncheck-inspect: all good');
}).catch((e) => { console.error(e); process.exit(1); });
