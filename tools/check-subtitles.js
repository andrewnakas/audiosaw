#!/usr/bin/env node
/*
 * Checks /add-subtitles-to-video.
 *
 * Node: ASSubs.parse reads SRT and WebVTT the lenient way players do, and
 * gives back what toSRT wrote; ASSubs.split cuts a cue into short pieces
 * that tile it exactly.
 *
 * Browser (needs Chrome, ffmpeg/ffprobe and the cached ffmpeg core):
 *   - own SRT, burned in: the text is drawn only while its cue is on
 *     screen, the sound is copied, the length kept;
 *   - own SRT as a track: the picture is not re-encoded (same frame count
 *     and codec), and the track reads back with the cue text;
 *   - automatic captions (Whisper base from the local mirror, skipped
 *     without it): a `say` clip's key words appear in the cues;
 *   - the burn speed on a 30 s 720p clip, which the page quotes.
 */
const fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync } = require('child_process');
const S = require('../js/subtitles.js');
let failed = 0;
function ok(c, m) { console.log((c ? '  ok  ' : '  FAIL ') + m); if (!c) failed++; }

console.log('parse and split');
{
  const vtt = '﻿WEBVTT\n\nNOTE a comment\n\nintro\n00:00:01.500 --> 00:00:03.000 align:start position:10%\n<v Ann><i>Hello</i> there</v>\n\n00:04.000 --> 00:05.250\nSecond\nline\n';
  const p = S.parse(vtt);
  ok(p.length === 2 && p[0].text === 'Hello there' && p[0].start === 1.5 && p[0].end === 3 && p[1].start === 4 && p[1].text === 'Second\nline', 'WebVTT: header, NOTE, cue ids, settings and tags handled');
  const srt = '1\r\n00:00:00,500 --> 00:00:02,000\r\n{\\an8}One\r\n\r\n2\r\n00:00:02,500 --> 00:00:04,100\r\nTwo';
  const q = S.parse(srt);
  ok(q.length === 2 && q[0].text === 'One' && q[1].end === 4.1, 'SRT: CRLF, ASS override tags, no trailing blank line');
  const segs = [{ text: 'The keeper lit the lamp at six.', start: 0.4, end: 2.2 }, { text: 'Then he climbed the stairs, slowly, counting each one.', start: 2.5, end: 6 }];
  const back = S.parse(S.toSRT(segs, 7));
  ok(back.length === 2 && back.every((c, i) => Math.abs(c.start - segs[i].start) < 0.001 && Math.abs(c.end - segs[i].end) < 0.001 && c.text.replace(/\n/g, ' ') === segs[i].text), 'what toSRT writes parses back to the same cues');
  const sp = S.split(segs, 4);
  const tiles = sp.every((c, i) => i === 0 || Math.abs(c.start - sp[i - 1].end) < 1e-9 || Math.abs(c.start - 2.5) < 1e-9);
  ok(sp.length >= 4 && sp.every((c) => c.text.split(/\s+/).length <= 5) && tiles && Math.abs(sp[sp.length - 1].end - 6) < 1e-9, 'split: short pieces that tile each cue exactly (' + sp.map((c) => c.text).join(' | ') + ')');
}

async function browser() {
  const { withPage, findChrome } = require('./chrome-harness');
  const core = path.join(os.homedir(), '.cache', 'audiosaw', 'ffmpeg-core-0.12.6.wasm');
  let tools = true;
  try { execFileSync('ffprobe', ['-version'], { stdio: 'ignore' }); execFileSync('say', ['-v', '?'], { stdio: 'ignore' }); } catch (e) { tools = false; }
  if (!findChrome() || !tools || !fs.existsSync(core)) { console.log('  skip: page (needs Chrome, ffmpeg, say and the cached ffmpeg core)'); return; }
  const mirror = require('./model-mirror'), WB = 'onnx-community/whisper-base';
  const haveWhisper = mirror.has(WB, mirror.WHISPER_BASE);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'as-subs-'));
  execFileSync('say', ['-v', 'Daniel', '-o', path.join(dir, 's.aiff'), 'The lighthouse keeper climbed the stairs and lit the lamp before the storm.']);
  const vid = path.join(dir, 'in.mp4');
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=navy:s=640x360:r=25:d=8', '-i', path.join(dir, 's.aiff'),
    '-filter_complex', '[1:a]adelay=500|500,apad=whole_dur=8[a]', '-map', '0:v', '-map', '[a]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '44100', '-t', '8', vid]);
  const big = path.join(dir, 'big.mp4');
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=30', '-f', 'lavfi', '-i', 'sine=f=300:d=30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', big]);
  const srt = '1\n00:00:02,000 --> 00:00:05,000\nThe harbour is quiet tonight.\n';
  const routes = Object.assign(haveWhisper ? mirror.routes([WB]) : {}, {
    '/__in.mp4': () => fs.readFileSync(vid), '/__big.mp4': () => fs.readFileSync(big), '/__core.wasm': () => fs.readFileSync(core)
  });
  await withPage({ routes }, async (page) => {
    page.listen('Fetch.requestPaused', (p) => {
      const u = p.request.url.split('?')[0], wb = /whisper-base\/resolve\/[^/]+\/(.+)$/.exec(u);
      page.send('Fetch.continueRequest', { requestId: p.requestId, url: page.url(wb ? '/__hf/' + WB + '/' + wb[1] : '/__core.wasm') });
    });
    await page.send('Fetch.enable', { patterns: [{ urlPattern: '*ffmpeg-core.wasm*' }].concat(haveWhisper ? [{ urlPattern: '*huggingface.co/onnx-community/whisper-base/*' }] : []) });
    await page.goto('/add-subtitles-to-video', 1500);
    const run = (opts) => page.eval(`(async () => {
      const o = ${JSON.stringify(opts)};
      const files = [new File([await (await fetch(o.video)).blob()], 'clip.mp4', { type: 'video/mp4' })];
      if (o.srt) files.push(new File([o.srt], 'clip.srt', { type: 'application/x-subrip' }));
      const dt = new DataTransfer(); files.forEach((f) => dt.items.add(f));
      const inp = document.querySelector('#fileInput'); inp.files = dt.files; inp.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 300));
      const src = document.querySelector('#source'); src.value = o.srt ? 'file' : 'auto'; src.dispatchEvent(new Event('change'));
      if (!o.srt) { document.querySelector('#language').value = 'en'; document.querySelector('#model').value = 'onnx-community/whisper-base'; }
      await window.__subPage.make();
      const cues = window.__subPage.cues();
      if (!cues) return { err: document.querySelector('#status').textContent };
      if (!o.out) return { cues };
      const t0 = performance.now(); window.__subs = null;
      await window.__subPage[o.out]();
      if (!window.__subs) return { err: document.querySelector('#status').textContent };
      const u = new Uint8Array(await window.__subs.blob.arrayBuffer());
      let bin = ''; for (let i = 0; i < u.length; i += 8192) bin += String.fromCharCode.apply(null, u.subarray(i, i + 8192));
      return { cues, b64: btoa(bin), ms: performance.now() - t0, font: window.__subPage.font() };
    })()`, 1800000);
    const save = (r, name) => { const f = path.join(dir, name); fs.writeFileSync(f, Buffer.from(r.b64, 'base64')); return f; };
    const probe = (f) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-count_packets', '-show_streams', '-show_format', '-of', 'json', f], { encoding: 'utf8' }));
    const bright = (f, t) => { const b = execFileSync('ffmpeg', ['-loglevel', 'error', '-ss', String(t), '-i', f, '-frames:v', '1', '-vf', 'crop=640:90:0:270,format=gray', '-f', 'rawvideo', '-']); let n = 0; for (const p of b) if (p > 200) n++; return n; };

    const b = await run({ video: '/__in.mp4', srt, out: 'burn' });
    ok(!b.err, 'own SRT burned in' + (b.err ? ' — ' + b.err : ' (' + (b.ms / 1000).toFixed(1) + ' s for 8 s of 360p)'));
    if (!b.err) {
      const f = save(b, 'burn.mp4'), pi = probe(vid), po = probe(f);
      const before = bright(f, 1.0), during = bright(f, 3.5), after = bright(f, 6.5);
      ok(before === 0 && during > 300 && after === 0, 'the caption is drawn only while its cue is on (' + before + ' / ' + during + ' / ' + after + ' bright pixels)');
      ok(po.streams.some((s) => s.codec_type === 'video' && s.codec_name === 'h264') && Math.abs(parseFloat(po.format.duration) - parseFloat(pi.format.duration)) < 0.1, 'H.264 MP4, length kept (' + parseFloat(po.format.duration).toFixed(2) + ' s)');
      const ai = pi.streams.find((s) => s.codec_type === 'audio'), ao = po.streams.find((s) => s.codec_type === 'audio');
      ok(ao && ao.codec_name === ai.codec_name && ao.nb_read_packets === ai.nb_read_packets, 'the sound is copied, not re-encoded (' + (ao ? ao.nb_read_packets + ' of ' + ai.nb_read_packets + ' packets' : 'none') + ')');
    }

    const s = await run({ video: '/__in.mp4', srt, out: 'soft' });
    ok(!s.err, 'own SRT as a track' + (s.err ? ' — ' + s.err : ' (' + (s.ms / 1000).toFixed(1) + ' s)'));
    if (!s.err) {
      const f = save(s, 'soft.mp4'), pi = probe(vid), po = probe(f);
      const vi = pi.streams.find((x) => x.codec_type === 'video'), vo = po.streams.find((x) => x.codec_type === 'video');
      const sub = po.streams.find((x) => x.codec_type === 'subtitle');
      ok(sub && sub.codec_name === 'mov_text' && vo.nb_read_packets === vi.nb_read_packets && vo.codec_name === vi.codec_name, 'a mov_text track beside the untouched picture (' + (sub ? sub.codec_name : 'no track') + ', ' + vo.nb_read_packets + ' frames)');
      const text = execFileSync('ffmpeg', ['-loglevel', 'error', '-i', f, '-map', '0:s:0', '-f', 'srt', '-'], { encoding: 'utf8' });
      ok(/00:00:02,000 --> 00:00:05,000/.test(text) && /harbour is quiet tonight/.test(text), 'the track reads back with its time and text');
    }

    // Hindi and Arabic: libass shapes them (HarfBuzz) given the right font,
    // which the page picks from the captions' script.
    for (const [lang, line, want] of [['Hindi', 'नमस्ते, आज हम रसोई का नल ठीक करेंगे।', 'Devanagari'], ['Arabic', 'مرحبا، سنصلح صنبور المطبخ اليوم.', 'Arabic']]) {
      const h = await run({ video: '/__in.mp4', srt: '1\n00:00:02,000 --> 00:00:05,000\n' + line + '\n', out: 'burn' });
      if (h.err) { ok(false, lang + ' burn: ' + h.err); continue; }
      const f = save(h, lang + '.mp4'), during = bright(f, 3.5), before = bright(f, 1.0);
      ok(new RegExp(want).test(h.font) && before === 0 && during > 150, lang + ' captions burn in with ' + h.font + ' (' + during + ' bright pixels in the cue, ' + before + ' before)');
    }

    if (haveWhisper) {
      const a = await run({ video: '/__in.mp4' });
      const words = a.err ? '' : a.cues.map((c) => c.text).join(' ').toLowerCase();
      const keys = ['lighthouse', 'keeper', 'stairs', 'lamp', 'storm'].filter((k) => words.includes(k));
      ok(!a.err && keys.length >= 4, 'automatic captions from the speech: "' + (a.err || words) + '" (' + keys.length + '/5 key words)');
    } else console.log('  skip: automatic captions (whisper-base not in the mirror)');

    const big1 = await run({ video: '/__big.mp4', srt: '1\n00:00:01,000 --> 00:00:29,000\nA long caption over the whole clip.\n', out: 'burn' });
    ok(!big1.err, 'speed: 30 s of 720p burned in ' + (big1.err ? '— ' + big1.err : (big1.ms / 1000).toFixed(1) + ' s (' + (big1.ms / 30000).toFixed(2) + 'x the video\'s length)'));
    if (page.logs.length) console.log('    console: ' + page.logs.slice(0, 4).join(' | '));
  });
}

browser().catch((e) => ok(false, 'browser: ' + (e.stack || e))).then(() => {
  if (failed) { console.log(`\n${failed} check(s) failed`); process.exit(1); }
  console.log('\ncheck-subtitles: all good');
});
