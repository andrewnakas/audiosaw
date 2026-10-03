#!/usr/bin/env node
/*
 * Video in, video out on the same-length audio tools (CV.shell's `video`
 * option, CV.remuxVideo in tool-shell.js): /noise-reduction, /audio-eq,
 * /vocal-remover, /pitch-shifter and /voice-changer.
 *
 * Each page gets a 6 s MP4 (a test picture; speech in stereo, with a hum
 * and noise under it) and must hand back a video whose picture stream is the
 * original's (same codec, same frame count), the same length, with new sound.
 * For the two tools that keep the waveform's shape (noise reduction, EQ),
 * the new sound must also line up with the old: the cross-correlation peak
 * within 2 ms, which is what "it stays in sync" means.
 *
 * Needs Chrome, macOS say, ffmpeg/ffprobe and the cached ffmpeg core.
 */
const fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync } = require('child_process');
let failed = 0;
function ok(c, m) { console.log((c ? '  ok  ' : '  FAIL ') + m); if (!c) failed++; }

const SR = 24000;
function pcm(f) { const b = execFileSync('ffmpeg', ['-loglevel', 'error', '-i', f, '-vn', '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-']); return new Float32Array(b.buffer, b.byteOffset, b.length >> 2); }
// Lag (in samples) of b against a, searched within ±maxLag, on 1-4 s.
function lag(a, b, maxLag) {
  const s = SR, e = 4 * SR; let best = 0, bv = -Infinity;
  for (let L = -maxLag; L <= maxLag; L++) {
    let v = 0; for (let i = s; i < e; i += 2) v += a[i] * (b[i + L] || 0);
    if (v > bv) { bv = v; best = L; }
  }
  return best;
}

async function main() {
  const { withPage, findChrome } = require('./chrome-harness');
  const core = path.join(os.homedir(), '.cache', 'audiosaw', 'ffmpeg-core-0.12.6.wasm');
  let tools = true;
  try { execFileSync('say', ['-v', '?'], { stdio: 'ignore' }); execFileSync('ffprobe', ['-version'], { stdio: 'ignore' }); } catch (e) { tools = false; }
  if (!findChrome() || !tools || !fs.existsSync(core)) { console.log('  skip: needs Chrome, say, ffmpeg and the cached ffmpeg core'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'as-vt-'));
  execFileSync('say', ['-v', 'Daniel', '-o', path.join(dir, 's.aiff'), 'The harbour lights came on one by one as the fog rolled in from the sea.']);
  const vid = path.join(dir, 'in.mp4');
  // Speech slightly left of centre, a 60 Hz hum and pink noise under it.
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=25:d=6', '-i', path.join(dir, 's.aiff'),
    '-f', 'lavfi', '-i', 'sine=f=60:d=6:sample_rate=44100', '-f', 'lavfi', '-i', 'anoisesrc=c=pink:d=6:a=0.02:r=44100',
    '-filter_complex', '[1:a]aresample=44100,adelay=400|400,apad=whole_dur=6,pan=stereo|c0=0.9*c0|c1=0.6*c0[v];[2:a]volume=0.05,pan=stereo|c0=c0|c1=c0[h];[3:a]pan=stereo|c0=c0|c1=c0[n];[v][h][n]amix=inputs=3:normalize=0[a]',
    '-map', '0:v', '-map', '[a]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-t', '6', vid]);
  const probe = (f) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-count_packets', '-show_streams', '-show_format', '-of', 'json', f], { encoding: 'utf8' }));
  const pi = probe(vid), vi = pi.streams.find((s) => s.codec_type === 'video'), xin = pcm(vid);
  await withPage({ routes: { '/__in.mp4': () => fs.readFileSync(vid), '/__core.wasm': () => fs.readFileSync(core) } }, async (page) => {
    page.listen('Fetch.requestPaused', (p) => page.send('Fetch.continueRequest', { requestId: p.requestId, url: page.url('/__core.wasm') }));
    await page.send('Fetch.enable', { patterns: [{ urlPattern: '*ffmpeg-core.wasm*' }] });
    for (const [slug, shape] of [['noise-reduction', true], ['audio-eq', true], ['vocal-remover', false], ['pitch-shifter', false], ['voice-changer', false]]) {
      await page.goto('/' + slug, 1500);
      const r = await page.eval(`(async () => {
        const f = new File([await (await fetch('/__in.mp4')).blob()], 'clip.mp4', { type: 'video/mp4' });
        const dt = new DataTransfer(); dt.items.add(f);
        const inp = document.querySelector('#fileInput'); inp.files = dt.files; inp.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 300));
        ${slug === 'pitch-shifter' ? "const st = document.querySelector('#semitones, #pitch, input[type=range]'); if (st) { st.value = 3; st.dispatchEvent(new Event('input')); }" : ''}
        let got = null; const o = CV.downloadBlob; CV.downloadBlob = (b, n) => { got = { b, n }; };
        document.querySelector('#convertBtn').click();
        for (let i = 0; i < 1800 && !got && !/Could not|failed/i.test(document.querySelector('#status').textContent); i++) await new Promise((r) => setTimeout(r, 100));
        CV.downloadBlob = o;
        if (!got) return { err: document.querySelector('#status').textContent };
        const u = new Uint8Array(await got.b.arrayBuffer());
        let bin = ''; for (let i = 0; i < u.length; i += 8192) bin += String.fromCharCode.apply(null, u.subarray(i, i + 8192));
        return { n: got.n, b64: btoa(bin), saved: (document.querySelector('.signal-out, [data-sig=out]') || {}).textContent || '' };
      })()`, 900000);
      if (r.err) { ok(false, slug + ': ' + r.err); continue; }
      const out = path.join(dir, slug + '.mp4');
      fs.writeFileSync(out, Buffer.from(r.b64, 'base64'));
      const po = probe(out), vo = po.streams.find((s) => s.codec_type === 'video'), ao = po.streams.find((s) => s.codec_type === 'audio');
      const xo = pcm(out);
      let diff = 0; for (let i = SR; i < 4 * SR; i++) diff += Math.abs(xo[i] - xin[i]);
      const parts = [
        /\.mp4$/.test(r.n) ? null : 'name ' + r.n,
        vo && vo.codec_name === vi.codec_name && vo.nb_read_packets === vi.nb_read_packets ? null : 'picture not copied',
        ao && ao.codec_name === 'aac' ? null : 'no AAC sound',
        Math.abs(parseFloat(po.format.duration) - parseFloat(pi.format.duration)) < 0.1 ? null : 'length ' + po.format.duration,
        diff / (3 * SR) > 1e-3 ? null : 'sound unchanged'
      ].filter(Boolean);
      let sync = '';
      if (shape) { const L = lag(xin, xo, Math.round(0.05 * SR)); sync = ', sound offset ' + (L / SR * 1000).toFixed(1) + ' ms'; if (Math.abs(L) > 0.002 * SR) parts.push('out of sync by ' + (L / SR * 1000).toFixed(1) + ' ms'); }
      ok(!parts.length, slug + ': video in, video out (' + (vo ? vo.nb_read_packets : 0) + '/' + vi.nb_read_packets + ' frames copied, ' + parseFloat(po.format.duration).toFixed(2) + ' s' + sync + ')' + (parts.length ? ' — ' + parts.join('; ') : ''));
    }
    if (page.logs.length) console.log('    console: ' + page.logs.slice(0, 4).join(' | '));
  });
}

main().catch((e) => ok(false, e.stack || e)).then(() => {
  if (failed) { console.log(`\n${failed} check(s) failed`); process.exit(1); }
  console.log('\ncheck-video-tools: all good');
});
