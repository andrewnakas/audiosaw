#!/usr/bin/env node
/*
 * Checks /split-audio's cuts (js/split-audio.js), in headless Chrome with a
 * local ffmpeg-made MP3 whose gaps are at known places:
 *   tone 3 s | 2.5 s silence | tone 4 s | 3 s silence | tone 2 s  (14.5 s)
 * The gaps' middles are 4.25 s and 11.0 s. Stream copy cuts on MP3 frames
 * (26 ms) and keeps the encoder delay, so copied parts are within 0.15 s.
 *   - decoded: silence mode makes 3 parts that cut inside the gaps;
 *   - "out of memory" (decodeToAudioBuffer made to throw a RangeError, as a
 *     two-hour file does on a phone): silence mode finds the same gaps with
 *     ffmpeg's silencedetect and stream-copies 3 MP3 parts, and equal parts
 *     still cut by copy. GA4, 19 Oct-15 Nov: 12 of 109 visitors hit memory
 *     here, and silence mode had no fallback until 16 Nov 2026.
 * Part lengths are read back with ffprobe. Needs the ffmpeg core in
 * ~/.cache/audiosaw (check-fidelity downloads it).
 */
const fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync } = require('child_process');

let failed = 0;
const ok = (c, m) => { console.log((c ? '  ok  ' : '  FAIL ') + m); if (!c) failed++; };

async function main() {
  const { withPage, findChrome } = require('./chrome-harness');
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); } catch (e) { console.log('  skip: needs local ffmpeg'); return; }
  const CORE = path.join(os.homedir(), '.cache', 'audiosaw', 'ffmpeg-core-0.12.6.wasm');
  if (!findChrome() || !fs.existsSync(CORE)) { console.log('  skip: needs Chrome and the ffmpeg core in ~/.cache/audiosaw'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'as-split-'));
  const mp3 = path.join(dir, 'take.mp3');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i',
    "aevalsrc='0.5*sin(2*PI*330*t)*(lt(t,3)+between(t,5.5,9.5)+gte(t,12.5))':s=44100:d=14.5", '-ac', '2', '-b:a', '192k', mp3]);
  const dur = (f) => +execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString().trim();

  await withPage({ routes: { '/__take.mp3': () => fs.readFileSync(mp3), '/__core.wasm': () => fs.readFileSync(CORE) } }, async (page) => {
    page.listen('Fetch.requestPaused', (p) => page.send('Fetch.continueRequest', { requestId: p.requestId, url: page.url('/__core.wasm') }));
    await page.send('Fetch.enable', { patterns: [{ urlPattern: '*unpkg.com*ffmpeg-core.wasm*' }] });
    await page.goto('/split-audio', 1500);
    const run = (opts, oom) => page.eval(`(async () => {
      const f = new File([await (await fetch('/__take.mp3')).blob()], 'take.mp3', { type: 'audio/mpeg' });
      const orig = AudioSaw.decodeToAudioBuffer;
      if (${oom}) AudioSaw.decodeToAudioBuffer = () => Promise.reject(new RangeError('Array buffer allocation failed'));
      try {
        const outs = await window.__split.process(f, ${JSON.stringify(opts)}, () => {});
        const parts = [];
        for (const o of outs) { const u8 = new Uint8Array(await o.blob.arrayBuffer()); let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); parts.push({ name: o.name, b64: btoa(s) }); }
        return { parts };
      } catch (e) { return { err: String(e && e.message || e) }; }
      finally { AudioSaw.decodeToAudioBuffer = orig; }
    })()`, 300000);
    const lens = (r, tag) => r.parts.map((p, i) => { const f = path.join(dir, tag + i + '.' + p.name.split('.').pop()); fs.writeFileSync(f, Buffer.from(p.b64, 'base64')); return dur(f); });
    const ends = (l) => l.slice(0, -1).map((_, i) => l.slice(0, i + 1).reduce((a, b) => a + b, 0));
    // A cut is right if it falls inside its gap (3-5.5 s, 9.5-12.5 s).
    const inGaps = (c) => c.length === 2 && c[0] > 3 && c[0] < 5.5 && c[1] > 9.5 && c[1] < 12.5;

    const silence = { mode: 'silence', thresholdDb: -45, minGapSec: 2, fmt: 'mp3', bitrate: '192', parts: 2, seconds: 300 };
    const a = await run(silence, false);
    if (a.err) ok(false, 'decoded, silence: ' + a.err);
    else { const l = lens(a, 'a'), c = ends(l); ok(a.parts.length === 3 && inGaps(c), 'decoded, silence mode: 3 parts, cuts at ' + c.map((x) => x.toFixed(2)).join(' and ') + ' s, inside the gaps'); }

    const b = await run(silence, true);
    if (b.err) ok(false, 'out of memory, silence: ' + b.err);
    else {
      const l = lens(b, 'b'), c = ends(l);
      ok(b.parts.length === 3 && inGaps(c) && b.parts.every((p) => /\.mp3$/.test(p.name)), 'out of memory, silence mode: ffmpeg finds the gaps, 3 MP3 parts by stream copy, cuts at ' + c.map((x) => x.toFixed(2)).join(' and ') + ' s');
      ok(Math.abs(l.reduce((x, y) => x + y, 0) - dur(mp3)) < 0.1, 'out of memory, silence mode: the parts add up to the whole (' + l.map((x) => x.toFixed(2)).join(' + ') + ' s)');
    }

    const c = await run(Object.assign({}, silence, { mode: 'parts', parts: 2 }), true);
    if (c.err) ok(false, 'out of memory, equal parts: ' + c.err);
    else { const l = lens(c, 'c'); ok(c.parts.length === 2 && Math.abs(l[0] - l[1]) < 0.15, 'out of memory, equal parts: 2 parts of ' + l.map((x) => x.toFixed(2)).join(' and ') + ' s'); }

    const d = await run(Object.assign({}, silence, { minGapSec: 5 }), true);
    ok(d.err && /No gaps/.test(d.err), 'out of memory, no gap long enough: said so — ' + (d.err || 'no error'));
    if (page.logs.length) console.log('    console: ' + page.logs.slice(0, 4).join(' | '));
  });
}

main().then(() => {
  console.log(failed ? '\n' + failed + ' check(s) failed' : '\ncheck-split: all good');
  process.exit(failed ? 1 : 0);
}).catch((e) => { console.error(e); process.exit(1); });
