#!/usr/bin/env node
/*
 * Checks /lyrics-from-song in headless Chrome (WebGPU flags, as check-tts):
 * six lines said by `say` at known times over a synthetic band (sawtooth
 * chords, bass, kick and hats) at the same loudness as the voice, run through
 * the real page twice, with the vocal separated first and without.
 *
 * Holds (the page quotes these):
 *   - with separation, at least 85% of the words come back, in order;
 *   - every line's start is within 0.3 s of where it was laid;
 *   - nothing is written in the instrumental gaps (no invented lines);
 *   - the LRC download reads back as one timed line per lyric line.
 * Reports the same figures without separation, for the page's comparison.
 *
 * Models from the local mirror (tools/model-mirror.js): Whisper base
 * timestamped and the stem splitter's MDX-Net.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

let failed = 0;
const ok = (c, m) => { console.log((c ? '  ok  ' : '  FAIL ') + m); if (!c) failed++; };

const W = 'onnx-community/whisper-base_timestamped', STEM = 'Politrees/UVR_resources';
const LINES = [
  'The city lights are fading in the rain',
  'I hear your footsteps walking down the lane',
  'We never said the words we meant to say',
  'And every morning took the night away',
  'So hold the moment tighter than before',
  'Until the silence knocks upon the door'
];
const R = 44100, BPM = 96, beat = 60 / BPM;

function band(sec) {
  const x = new Float32Array(Math.round(sec * R));
  const chords = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]];
  const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);
  for (let i = 0; i < x.length; i++) {
    const t = i / R, b = t / beat, bar = Math.floor(b / 4) % 4, ch = chords[bar];
    let v = 0;
    ch.forEach((m) => { const f = hz(m); v += 0.06 * (2 * ((t * f) % 1) - 1); });
    v += 0.15 * Math.sin(2 * Math.PI * hz(ch[0] - 12) * t);
    const pb = b % 1, kick = pb < 0.25 ? Math.sin(2 * Math.PI * (50 + 80 * Math.exp(-pb * 30)) * pb * beat) * Math.exp(-pb * 12) : 0;
    v += 0.5 * kick;
    const ph = (b * 2) % 1;
    v += ph < 0.05 ? 0.08 * (Math.random() * 2 - 1) * (1 - ph / 0.05) : 0;
    x[i] = v;
  }
  return x;
}

async function main() {
  const { withPage, findChrome } = require('./chrome-harness');
  const mirror = require('./model-mirror');
  try { execFileSync('say', ['-v', '?'], { stdio: 'ignore' }); execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); } catch (e) { console.log('  skip: needs say and ffmpeg'); return; }
  if (!findChrome() || !mirror.has(W, mirror.WHISPER_BASE) || !mirror.has(STEM, ['models/MDXNet/UVR-MDX-NET-Voc_FT.onnx'])) { console.log('  skip: models not in the mirror'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'as-lyr-'));
  // Lines start every 4.5 s, with a 9 s instrumental gap after the third.
  const starts = [1.5, 6, 10.5, 19.5, 24, 28.5];
  const total = 33;
  const voice = new Float32Array(total * R);
  LINES.forEach((l, i) => {
    const a = path.join(dir, i + '.aiff'), b = path.join(dir, i + '.raw');
    execFileSync('say', ['-v', 'Samantha', '-o', a, l]);
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', a, '-af', 'silenceremove=start_periods=1:start_threshold=-45dB,aresample=' + R, '-ac', '1', '-f', 'f32le', b]);
    const buf = fs.readFileSync(b), x = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
    voice.set(x.subarray(0, Math.min(x.length, voice.length - Math.round(starts[i] * R))), Math.round(starts[i] * R));
  });
  const bed = band(total);
  const rms = (x) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);
  // Same loudness as the voice where it sings (the voice's RMS over its lines).
  let vs = 0, vn = 0; starts.forEach((s) => { for (let i = Math.round(s * R); i < Math.round((s + 3) * R); i++) { vs += voice[i] * voice[i]; vn++; } });
  const g = Math.sqrt(vs / vn) / rms(bed);
  const mix = new Float32Array(voice.length);
  for (let i = 0; i < mix.length; i++) mix[i] = 0.7 * (voice[i] + bed[i] * g);
  const wav = path.join(dir, 'song.wav');
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'f32le', '-ar', String(R), '-ac', '1', '-i', '-', '-ac', '2', '-c:a', 'pcm_s16le', wav], { input: Buffer.from(mix.buffer) });

  const truthWords = LINES.join(' ').toLowerCase().replace(/[^a-z' ]/g, '').split(/\s+/);
  function wordScore(text) {
    const got = text.toLowerCase().replace(/[^a-z' ]/g, ' ').split(/\s+/).filter(Boolean);
    // Longest common subsequence: words back, in order.
    const dp = Array(truthWords.length + 1).fill(0).map(() => Array(got.length + 1).fill(0));
    for (let i = 1; i <= truthWords.length; i++) for (let j = 1; j <= got.length; j++)
      dp[i][j] = truthWords[i - 1] === got[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    return dp[truthWords.length][got.length] / truthWords.length;
  }

  const routes = Object.assign(mirror.routes([W, STEM]), { '/__song.wav': () => fs.readFileSync(wav) });
  await withPage({ routes, headers: true, args: ['--enable-unsafe-webgpu', '--use-angle=metal', '--ignore-gpu-blocklist'] }, async (page) => {
    await mirror.attach(page, [W, STEM]);
    await page.goto('/lyrics-from-song', 1500);
    for (const iso of [true, false]) {
      const t0 = Date.now();
      const r = await page.eval(`(async () => {
        const b = await (await fetch('/__song.wav')).blob();
        window.__lyrics.use(new File([b], 'song.wav', { type: 'audio/wav' }));
        window.__lyrics.isolate(${iso});
        await window.__lyrics.run();
        const lines = (window.__lyrics.lines() || []).map((l) => ({ start: l.start, end: l.end, text: l.text }));
        let lrc = '';
        if (lines.length) { const o = CV.downloadBlob; CV.downloadBlob = async (bl) => { lrc = await bl.text(); }; document.querySelector('#dlLrc').click(); await new Promise((r) => setTimeout(r, 200)); CV.downloadBlob = o; }
        return { lines, lrc, status: document.querySelector('#status').textContent };
      })()`, 1800000);
      const secs = (Date.now() - t0) / 1000;
      const label = iso ? 'separated' : 'not separated';
      if (!r.lines.length) { ok(!iso, label + ': no lines — ' + r.status); continue; }
      const text = r.lines.map((l) => l.text).join(' ');
      const score = wordScore(text);
      const errs = starts.map((s, i) => {
        const first = LINES[i].split(' ')[0].toLowerCase(), second = LINES[i].split(' ')[1].toLowerCase();
        const hit = r.lines.filter((l) => new RegExp('\\b(' + first + '|' + second + ')\\b', 'i').test(l.text)).sort((a, b) => Math.abs(a.start - s) - Math.abs(b.start - s))[0];
        return hit ? Math.abs(hit.start - s) : 9;
      });
      const worst = Math.max.apply(null, errs);
      const invented = r.lines.filter((l) => l.start > 13.6 && l.end < 19.3).length;
      console.log('       ' + label + ' (' + secs.toFixed(0) + ' s): ' + (score * 100).toFixed(1) + '% of words, worst line start ' + (worst * 1000).toFixed(0) + ' ms, ' + r.lines.length + ' lines');
      if (process.env.LYRICS_DEBUG) console.log('       ' + text);
      if (iso) {
        ok(score >= 0.85, 'separated: ' + (score * 100).toFixed(1) + '% of the words back, in order');
        ok(worst <= 0.3, 'separated: every line within 0.3 s of where it was sung (worst ' + (worst * 1000).toFixed(0) + ' ms)');
        ok(invented === 0, 'separated: nothing written in the 9 s instrumental gap (' + invented + ' lines)');
        const timed = r.lrc.split('\n').filter((l) => /^\[\d+:\d{2}\.\d{2}\]\S/.test(l));
        ok(timed.length === r.lines.length, 'the LRC reads back as ' + timed.length + ' timed lines for ' + r.lines.length + ' lyric lines');
      }
    }
    if (page.logs.length) console.log('    console: ' + page.logs.slice(0, 4).join(' | '));
  });
}

main().then(() => {
  console.log(failed ? '\n' + failed + ' check(s) failed' : '\ncheck-lyrics: all good');
  process.exit(failed ? 1 : 0);
}).catch((e) => { console.error(e); process.exit(1); });
