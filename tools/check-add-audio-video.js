#!/usr/bin/env node
/*
 * Checks /add-audio-to-video: the mixer (js/audio-bed.js) in Node, then the
 * page in headless Chrome with a real video made by local ffmpeg.
 *
 * What it holds, and why each matters:
 *   - replace writes the new track exactly, at the video's length;
 *   - ducking: the music sits at the chosen depth (±1 dB) under speech and
 *     back at full level in the pauses, measured on the music alone;
 *   - offset and skip put the first sample where they say;
 *   - a looped track has no level hole and no click at the seam;
 *   - the fade-out ends at silence;
 *   - in the browser: every frame of the picture copied, the length kept,
 *     and the original sound not moved against the picture (0 ms).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const B = require('../js/audio-bed.js');

let failed = 0;
const ok = (c, m) => { console.log((c ? '  ok  ' : '  FAIL ') + m); if (!c) failed++; };
const rms = (x, a, b) => { let s = 0; for (let i = a; i < b; i++) s += x[i] * x[i]; return Math.sqrt(s / (b - a)); };
const dB = (x) => 20 * Math.log10(x);

const R = 48000;
function sine(sec, f, amp, phase) {
  const x = new Float32Array(Math.round(sec * R));
  for (let i = 0; i < x.length; i++) x[i] = amp * Math.sin(2 * Math.PI * f * i / R + (phase || 0));
  return x;
}
// "Speech": band noise in 2 s bursts with 2 s pauses, over a quiet floor.
function talk(sec) {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  const x = new Float32Array(Math.round(sec * R));
  for (let i = 0; i < x.length; i++) {
    const on = Math.floor(i / R / 2) % 2 === 0;
    x[i] = rnd() * (on ? 0.15 : 0.001);
  }
  return x;
}

console.log('mixer');
{
  const music = [sine(5, 440, 0.3), sine(5, 440, 0.3, 1)];
  const r = B.mix({ rate: R, length: 4 * R, orig: [talk(4)], music, mode: 'replace' });
  let same = true;
  for (let i = Math.round(0.02 * R); i < 4 * R; i++) if (r.channels[0][i] !== music[0][i] || r.channels[1][i] !== music[1][i]) { same = false; break; }
  ok(same && r.channels[0].length === 4 * R, 'replace: the new track exactly, cut to the video\'s length');
}
{
  const orig = talk(16), m = sine(16, 440, 0.3);
  const r = B.mix({ rate: R, length: 16 * R, orig: [orig], music: [m, m], mode: 'duck', duckDb: 12 });
  const mus = r.channels[0].map((v, i) => v - orig[i]);   // the music alone
  const under = dB(rms(mus, Math.round(4.5 * R), Math.round(5.8 * R)) / 0.3 * Math.SQRT2);
  const pause = dB(rms(mus, Math.round(7.0 * R), Math.round(7.8 * R)) / 0.3 * Math.SQRT2);
  ok(Math.abs(under + 12) <= 1, 'ducking: music ' + under.toFixed(2) + ' dB under speech (asked -12)');
  ok(Math.abs(pause) <= 1, 'ducking: back to ' + pause.toFixed(2) + ' dB in a pause');
  const r6 = B.mix({ rate: R, length: 16 * R, orig: [orig], music: [m, m], mode: 'duck', duckDb: 6 });
  const u6 = dB(rms(r6.channels[0].map((v, i) => v - orig[i]), Math.round(4.5 * R), Math.round(5.8 * R)) / 0.3 * Math.SQRT2);
  ok(Math.abs(u6 + 6) <= 1, 'ducking depth follows the setting (' + u6.toFixed(2) + ' dB at -6)');
}
{
  const m = sine(3, 300, 0.3);
  const r = B.mix({ rate: R, length: 4 * R, orig: null, music: [m, m], offset: 1, skip: 0.5 });
  const first = r.channels[0].findIndex((v) => v !== 0);
  ok(Math.abs(first - R) <= 1, 'offset: the music begins at ' + (first / R).toFixed(4) + ' s (asked 1 s)');
  const k = R + Math.round(0.03 * R);   // past the 20 ms edge fade
  ok(Math.abs(r.channels[0][k] - m[k - R + Math.round(0.5 * R)]) < 1e-6, 'skip: it starts 0.5 s into the track');
}
{
  const m = sine(3, 220, 0.3, 0.4);
  const r = B.mix({ rate: R, length: 10 * R, orig: null, music: [m, m], loop: true });
  const x = r.channels[0];
  let worst = 0, step = 0;
  for (let t = 0.1; t < 9.9; t += 0.05) worst = Math.max(worst, Math.abs(dB(rms(x, Math.round(t * R), Math.round((t + 0.05) * R)) / (0.3 / Math.SQRT2))));
  for (let i = 1; i < x.length; i++) step = Math.max(step, Math.abs(x[i] - x[i - 1]));
  let inStep = 0; for (let i = 1; i < m.length; i++) inStep = Math.max(inStep, Math.abs(m[i] - m[i - 1]));
  ok(worst < 3.1, 'loop: level within ' + worst.toFixed(2) + ' dB across 10 s from a 3 s track (equal-power seams)');
  ok(step <= inStep * 1.5, 'loop: no click at a seam (largest step ' + step.toFixed(4) + ', the track\'s own ' + inStep.toFixed(4) + ')');
  ok(rms(x, Math.round(9.95 * R), 10 * R) > 0.05, 'loop: still playing at the end');
}
{
  const m = sine(6, 220, 0.3);
  const r = B.mix({ rate: R, length: 5 * R, orig: null, music: [m, m], fadeOut: 2 });
  const x = r.channels[0];
  ok(Math.abs(x[x.length - 1]) < 0.001 && rms(x, Math.round(2.5 * R), Math.round(2.9 * R)) > 0.15, 'fade-out: full until it starts, silent at the last sample');
}

/* --------------------------------------------------------------- browser */

async function browser() {
  const { withPage, findChrome } = require('./chrome-harness');
  let ff = null;
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); ff = 'ffmpeg'; } catch (e) {}
  if (!findChrome() || !ff) { console.log('  skip: browser part needs Chrome and local ffmpeg'); return; }
  const CORE = path.join(os.homedir(), '.cache', 'audiosaw', 'ffmpeg-core-0.12.6.wasm');
  if (!fs.existsSync(CORE)) { console.log('  skip: the ffmpeg core is not in ~/.cache/audiosaw (check-fidelity downloads it)'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'as-aav-'));
  const vid = path.join(dir, 'in.mp4'), song = path.join(dir, 'song.wav');
  // 6 s, 25 fps, with a click every second on the original sound so its
  // position in the output can be measured; and a 2.5 s "song".
  execFileSync(ff, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=6',
    '-f', 'lavfi', '-i', "aevalsrc='if(lt(mod(t,1),0.005),0.8,0)*sin(2*PI*1000*t)':s=48000:d=6",
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-shortest', vid]);
  execFileSync(ff, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000:duration=2.5', '-ac', '2', song]);

  await withPage({
    routes: { '/__in.mp4': () => fs.readFileSync(vid), '/__song.wav': () => fs.readFileSync(song), '/__core.wasm': () => fs.readFileSync(CORE) }
  }, async (page) => {
    page.listen('Fetch.requestPaused', (p) => page.send('Fetch.continueRequest', { requestId: p.requestId, url: page.url('/__core.wasm') }));
    await page.send('Fetch.enable', { patterns: [{ urlPattern: '*unpkg.com*ffmpeg-core.wasm*' }] });
    await page.goto('/add-audio-to-video', 1500);
    const res = await page.eval(`(async () => {
      const get = async (u, n, t) => new File([await (await fetch(u)).blob()], n, { type: t });
      const v = await get('/__in.mp4', 'clip.mp4', 'video/mp4'), s = await get('/__song.wav', 'song.wav', 'audio/wav');
      let out = null;
      const orig = CV.downloadBlob;
      CV.downloadBlob = (b, name) => { out = { b, name }; };
      await window.__aav.run(v, s, { mode: 'mix', musicDb: -60, loop: true, fadeOut: 0 });
      CV.downloadBlob = orig;
      if (!out) return { err: document.querySelector('#status').textContent };
      const u8 = new Uint8Array(await out.b.arrayBuffer());
      let str = ''; for (let i = 0; i < u8.length; i += 0x8000) str += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
      return { name: out.name, b64: btoa(str) };
    })()`, 600000);
    if (res.err) { ok(false, 'the page made a video — ' + res.err); return; }
    const outPath = path.join(dir, 'out.mp4');
    fs.writeFileSync(outPath, Buffer.from(res.b64, 'base64'));
    const probe = (args) => execFileSync('ffprobe', ['-v', 'error'].concat(args, [outPath])).toString().trim();
    const frames = +probe(['-select_streams', 'v:0', '-count_packets', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0']);
    const dur = +probe(['-select_streams', 'v:0', '-show_entries', 'stream=duration', '-of', 'csv=p=0']);
    ok(frames === 150, 'the picture copied: ' + frames + '/150 frames');
    ok(Math.abs(dur - 6) < 0.05, 'the length kept: ' + dur.toFixed(2) + ' s');
    // Where are the clicks now? Decode the output's sound and find each
    // second's onset; AAC delay is handled by the muxer's edit list.
    const pcm = execFileSync(ff, ['-v', 'error', '-i', outPath, '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'], { maxBuffer: 1 << 28 });
    const x = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.length / 4);
    const offs = [];
    for (let s = 1; s < 5; s++) {
      let k = -1;
      for (let i = Math.round((s - 0.1) * R); i < (s + 0.1) * R; i++) if (Math.abs(x[i]) > 0.2) { k = i; break; }
      offs.push((k - s * R) / R * 1000);
    }
    const worst = Math.max.apply(null, offs.map(Math.abs));
    ok(worst < 2, 'the original sound did not move against the picture (onsets ' + offs.map((o) => o.toFixed(1)).join(', ') + ' ms)');
    ok(/\.mp4$/.test(res.name), 'an MP4 named after the video (' + res.name + ')');
    if (page.logs.length) console.log('    console: ' + page.logs.slice(0, 4).join(' | '));
  });
}

browser().then(() => {
  console.log(failed ? '\n' + failed + ' check(s) failed' : '\ncheck-add-audio-video: all good');
  process.exit(failed ? 1 : 0);
}).catch((e) => { console.error(e); process.exit(1); });
