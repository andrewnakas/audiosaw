#!/usr/bin/env node
/*
 * Checks "Add speech…" in /audio-editor (js/editor-speech.js), in headless
 * Chrome with the Kokoro q8 model served from ~/.cache/audiosaw/kokoro
 * (check-tts fetches it with TTS_DOWNLOAD=1; skipped without it):
 *
 *   1. with the playhead inside a clip on the selected track, the speech goes
 *      on a new track and the clip is left whole (no carving);
 *   2. with the playhead past the end, it goes on the selected track, at the
 *      playhead;
 *   3. the clip is audible speech of a sensible length, in the export too,
 *      and its stored file is a WAV tagged as synthetic speech;
 *   4. one undo removes it.
 */
const fs = require('fs'), os = require('os'), path = require('path');
let failed = 0;
function ok(c, m) { console.log((c ? '  ok  ' : '  FAIL ') + m); if (!c) failed++; }

const CACHE = path.join(os.homedir(), '.cache', 'audiosaw', 'kokoro');
const FILES = ['model_quantized.onnx', 'af_heart.bin'];

const READ_PROJECT = `(function () {
  return new Promise(function (res, rej) {
    var r = indexedDB.open('audiosaw-editor', 1);
    r.onerror = function () { rej(r.error); };
    r.onsuccess = function () {
      var g = r.result.transaction('meta').objectStore('meta').get('project');
      g.onsuccess = function () { r.result.close(); res(g.result); };
    };
  });
})()`;

async function main() {
  const { withPage, findChrome } = require('./chrome-harness');
  if (!findChrome()) { console.log('  skip: no Chrome'); return; }
  if (!FILES.every((f) => fs.existsSync(path.join(CACHE, f)))) { console.log('  skip: Kokoro q8 is not in ' + CACHE + ' (check-tts.js with TTS_DOWNLOAD=1)'); return; }
  const routes = {};
  FILES.forEach((f) => { routes['/__kokoro/' + f] = () => fs.readFileSync(path.join(CACHE, f)); });
  await withPage({ routes }, async (page) => {
    page.listen('Fetch.requestPaused', (p) => {
      page.send('Fetch.continueRequest', { requestId: p.requestId, url: page.url('/__kokoro/' + p.request.url.split('?')[0].split('/').pop()) });
    });
    await page.send('Fetch.enable', { patterns: [{ urlPattern: '*huggingface.co/onnx-community/Kokoro*' }] });
    await page.goto('/audio-editor?backend=wasm', 1500);
    const r = await page.eval(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const project = () => ${READ_PROJECT}.then((s) => typeof s === 'string' ? JSON.parse(s) : s);
      const saved = async () => { await sleep(400); for (let i = 0; i < 300 && document.getElementById('edSaved').dataset.state !== 'saved'; i++) await sleep(100); };
      // A 3 s tone on track 1, as an imported file.
      const sr = 24000, n = 3 * sr, tone = AudioSaw.makeBuffer([Float32Array.from({ length: n }, (_, i) => 0.2 * Math.sin(2 * Math.PI * 220 * i / sr))], sr);
      const wav = await AudioSaw.encode(tone, 'wav16');
      const dt = new DataTransfer(); dt.items.add(new File([wav], 'tone.wav', { type: 'audio/wav' }));
      const inp = document.getElementById('fileInput'); inp.files = dt.files; inp.dispatchEvent(new Event('change', { bubbles: true }));
      for (let i = 0; i < 100 && !(await project().catch(() => null) || { tracks: [] }).tracks.some((t) => t.clips.length); i++) await sleep(100);
      await saved();
      const S = ASEditSpeech._state();
      async function add(text, t) {
        S.playhead = t; S.selTrack = S.project.tracks[0].id;
        ASEditSpeech.open();
        document.querySelector('.ed-speech textarea').value = text;
        const before = JSON.stringify(S.project);
        document.querySelector('.ed-sheet [data-v=go]').click();
        for (let i = 0; i < 1800 && JSON.stringify(S.project) === before && !/Could not/.test(document.getElementById('status').textContent); i++) await sleep(100);
        await saved();
        return project();
      }
      const p1 = await add('This line goes on a new track.', 1.0);
      const p2 = await add('And this one follows the tone.', 5.0);
      // Export, and find where the speech is loud.
      const res = await ASEditEngine.render(p2, 0, 12, { sampleRate: 24000, channels: 1 });
      const d = res.buffer.getChannelData(0), rms = (a, b) => { let s = 0; for (let i = Math.round(a * 24000); i < Math.round(b * 24000); i++) s += d[i] * d[i]; return Math.sqrt(s / Math.max(1, (b - a) * 24000)); };
      // The stored file of the second speech clip.
      const sid = p2.tracks[0].clips[1] && p2.tracks[0].clips[1].sourceId;
      const tag = await new Promise((res) => {
        const q = indexedDB.open('audiosaw-editor', 1);
        q.onsuccess = () => {
          const stores = Array.from(q.result.objectStoreNames), out = { stores };
          const st = stores.find((s) => /file|blob|audio|source/i.test(s));
          if (!st) { q.result.close(); res(out); return; }
          const g = q.result.transaction(st).objectStore(st).get(sid);
          g.onsuccess = async () => {
            const v = g.result, b = v && (v.file || v.blob || v);
            if (b && b.arrayBuffer) { const t = new TextDecoder('latin1').decode(new Uint8Array(await b.arrayBuffer())); out.riff = t.slice(0, 4); out.tagged = /Synthetic speech generated with Kokoro/.test(t); out.name = b.name; }
            q.result.close(); res(out);
          };
          g.onerror = () => { q.result.close(); res(out); };
        };
      });
      document.getElementById('edUndo').click();
      await saved();
      const p3 = await project();
      return { p1, p2, p3, tag, sil: rms(3.3, 4.8), sp1: rms(1.1, 2.5), sp2: rms(5.1, 6.5), status: document.getElementById('status').textContent };
    })()`, 1200000);
    const { p1, p2, p3 } = r;
    const clipsOf = (p) => p.tracks.map((t) => t.clips.map((c) => [c.start.toFixed(2), c.duration.toFixed(2)]));
    ok(p1.tracks.length === 2 && p1.tracks[0].clips.length === 1 && Math.abs(p1.tracks[0].clips[0].duration - 3) < 0.01 && p1.tracks[1].clips.length === 1 && Math.abs(p1.tracks[1].clips[0].start - 1) < 0.01,
      'playhead inside a clip: the speech goes on a new track at 1.00 s and the tone stays whole ' + JSON.stringify(clipsOf(p1)));
    const c2 = p2.tracks[0].clips[1];
    ok(p2.tracks.length === 2 && c2 && Math.abs(c2.start - 5) < 0.01, 'playhead past the end: it goes on the selected track at 5.00 s ' + JSON.stringify(clipsOf(p2)));
    ok(c2 && c2.duration > 1.2 && c2.duration < 4, 'a sensible length for the line (' + (c2 ? c2.duration.toFixed(2) : '?') + ' s)');
    ok(r.sp1 > 0.01 && r.sp2 > 0.01 && r.sp2 > r.sil * 5, 'audible in the export (rms ' + r.sp1.toFixed(3) + ', ' + r.sp2.toFixed(3) + ' against ' + r.sil.toFixed(4) + ' in the gap)');
    ok(r.tag.riff === 'RIFF' && r.tag.tagged && /^Speech - And this one/.test(r.tag.name || ''), 'stored as a WAV tagged as synthetic speech (' + JSON.stringify(r.tag) + ')');
    ok(p3.tracks[0].clips.length === 1 && p3.tracks.length === 2, 'one undo removes the second line ' + JSON.stringify(clipsOf(p3)));
    if (page.logs.length) console.log('    console: ' + page.logs.slice(0, 4).join(' | '));
  });
}

main().catch((e) => ok(false, e.stack || e)).then(() => {
  if (failed) { console.log(`\n${failed} check(s) failed`); process.exit(1); }
  console.log('\ncheck-editor-speech: all good');
});
