#!/usr/bin/env node
/*
 * Checks speaker labelling on /audio-to-text (diarize.js + diarize-worker.js).
 *
 * Node: turns from pyannote segments, clustering to a count and on Auto
 * (including the small-speaker fold), labelling Whisper segments, and the
 * transcript and subtitle formats.
 *
 * Browser (Chrome, macOS `say`, ffmpeg; the two models and Whisper base come
 * from the local mirror, fetched once): two synthetic conversations, built
 * from `say` voices with known turn times —
 *   - two people (Daniel, Samantha), 21 s: Auto must find 2 and label at
 *     least 94% of the speech right (measured 99.7%);
 *   - three people (Daniel, Samantha, Karen), 3 min: Auto must find 3 and
 *     label at least 90% right (measured 92.0%). Two women's voices are the
 *     case segmentation alone gets wrong (68%);
 * and the page itself with "label who is speaking" ticked: the transcript
 * has a "Speaker 1:" and a "Speaker 2:" paragraph, and the SRT names them.
 * The page's "over 99% / 92%" are these numbers; tighten here before changing it.
 */
const fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync } = require('child_process');
const D = require('../js/diarize.js');

let failed = 0;
function ok(c, m) { console.log((c ? '  ok  ' : '  FAIL ') + m); if (!c) failed++; }

/* ------------------------------------------------------------------ Node */

console.log('clustering');
{
  const t = D.turns([{ id: 0, start: 0, end: 1 }, { id: 1, start: 1, end: 2 }, { id: 1, start: 2.1, end: 3 }, { id: 2, start: 3, end: 4 }, { id: 1, start: 5, end: 6 }]);
  ok(t.length === 3 && t[0].start === 1 && t[0].end === 3 && t[2].start === 5, 'turns: silence dropped, a local speaker joined across a short gap, not a long one');
}
function voice(base, k) { return Array.from({ length: 16 }, (_, i) => base[i] + 0.05 * Math.sin(i * 7 + k)); }
const A = Array.from({ length: 16 }, (_, i) => (i % 2 ? 1 : 0)), B = Array.from({ length: 16 }, (_, i) => (i < 8 ? 1 : -0.2)), Cv = Array.from({ length: 16 }, (_, i) => Math.cos(i));
{
  const items = [];
  for (let k = 0; k < 6; k++) items.push({ start: k * 4, end: k * 4 + 2, emb: voice(k % 2 ? B : A, k) });
  const l = D.cluster(items, {});
  ok(l.join('') === '121212', 'Auto: two alternating voices → 1,2,1,2… (' + l.join('') + ')');
  ok(D.cluster(items, { speakers: 1 }).every((x) => x === 1), 'a fixed count of 1 merges everything');
  const three = items.concat([{ start: 30, end: 33, emb: voice(Cv, 9) }, { start: 34, end: 37, emb: voice(Cv, 10) }]);
  ok(new Set(D.cluster(three, {})).size === 3, 'Auto finds a third voice');
  const blip = items.concat([{ start: 40, end: 40.6, emb: voice(Cv, 3) }]);
  ok(new Set(D.cluster(blip, {})).size === 2, 'a voice with under 8% of the speech is folded into its nearest');
}
{
  const turns = [{ start: 0, end: 3, speaker: 1 }, { start: 3, end: 6, speaker: 2 }];
  const segs = D.labelSegments([{ text: 'Hello there.', start: 0.2, end: 2.5 }, { text: 'Hi.', start: 3.1, end: 4 }, { text: 'Bye.', start: 4.2, end: 5.8 }], turns);
  ok(segs.map((s) => s.speaker).join('') === '122', 'Whisper segments take the speaker who talks most inside them');
  ok(D.toText(segs, { 2: 'Ana' }) === 'Speaker 1: Hello there.\n\nAna: Hi. Bye.', 'transcript: one paragraph per change of speaker, renames applied');
  const cues = D.prefixCues(segs, {});
  ok(cues[0].text === 'Speaker 1: Hello there.' && cues[1].text === 'Speaker 2: Hi.' && cues[2].text === 'Bye.', 'subtitles: the name at each change only');
}

/* --------------------------------------------------------------- browser */

const SR = 16000;
function conversation(voices, plan, minSecs) {
  const lines = ['Good morning, thanks for coming in to talk about the new bridge.', 'It has been a long few months for the whole team.', 'The design changed after the public meetings.',
    'We widened the footpath and moved the cycle lane.', 'The cost went up about four percent.', 'The council approved it last week.', 'Construction starts in the spring.',
    'There will be some closures on the river road.', 'We will publish the dates online.', 'People asked about lighting at night.', 'The new lamps are warmer and dimmer.',
    'What about the old pier?', 'It stays, and gets a new railing.', 'Thank you all for your time this morning.'];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'as-diar-'));
  const out = [new Float32Array(SR / 2)], truth = [];
  let t = 0.5;
  for (let r = 0; r < plan.length || t < minSecs; r++) {
    const v = voices[plan.length ? plan[r] : (r * 7 + (r % 2)) % voices.length];
    if (plan.length && r >= plan.length) break;
    execFileSync('say', ['-v', v, '-o', path.join(dir, 'l.aiff'), lines[r % lines.length]]);
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', path.join(dir, 'l.aiff'), '-ac', '1', '-ar', String(SR), '-f', 'f32le', path.join(dir, 'l.f32')]);
    const b = fs.readFileSync(path.join(dir, 'l.f32')), x = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
    truth.push({ who: v, start: t, end: t + x.length / SR }); out.push(x); t += x.length / SR;
    const gap = 0.3 + (r % 4) * 0.15; out.push(new Float32Array(Math.round(SR * gap))); t += gap;
  }
  const n = out.reduce((a, x) => a + x.length, 0), all = new Float32Array(n);
  let o = 0; out.forEach((x) => { all.set(x, o); o += x.length; });
  return { audio: all, truth, secs: n / SR };
}
// Share of the true speech carried by the right label, under the best
// one-to-one mapping of true people to labels.
function score(turns, truth) {
  const cover = (t, s) => turns.filter((u) => u.speaker === s).reduce((a, u) => a + Math.max(0, Math.min(u.end, t.end) - Math.max(u.start, t.start)), 0);
  const ids = [...new Set(turns.map((u) => u.speaker))], who = [...new Set(truth.map((t) => t.who))];
  const perms = (arr, k) => (k === 0 ? [[]] : arr.flatMap((x, i) => perms(arr.filter((_, j) => j !== i), k - 1).map((p) => [x].concat(p))));
  const pad = ids.concat(who.map((_, i) => -1 - i));
  let best = 0;
  perms(pad, who.length).forEach((p) => { let v = 0; who.forEach((w, i) => { v += truth.filter((t) => t.who === w).reduce((a, t) => a + cover(t, p[i]), 0); }); best = Math.max(best, v); });
  return best / truth.reduce((a, t) => a + t.end - t.start, 0);
}
function wav16(x) {
  const b = Buffer.alloc(44 + x.length * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + x.length * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(SR, 24); b.writeUInt32LE(SR * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(x.length * 2, 40);
  for (let i = 0; i < x.length; i++) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x[i] * 32767))), 44 + i * 2);
  return b;
}

async function browser() {
  const { withPage, findChrome } = require('./chrome-harness');
  let tools = true;
  try { execFileSync('say', ['-v', '?'], { stdio: 'ignore' }); execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); } catch (e) { tools = false; }
  if (!findChrome() || !tools) { console.log('  skip: needs Chrome, macOS say and ffmpeg'); return; }
  const mirror = require('./model-mirror');
  const SEG = 'onnx-community/pyannote-segmentation-3.0', EMB = 'onnx-community/wespeaker-voxceleb-resnet34-LM', WB = 'onnx-community/whisper-base';
  mirror.fetch(SEG, ['config.json', 'preprocessor_config.json', 'onnx/model.onnx'], '733a93b6473d019a773298e08cefa686894b1854');
  mirror.fetch(EMB, ['config.json', 'preprocessor_config.json', 'onnx/model.onnx'], '6a61a1833ff2583aabeba044f5c8221f00b67ceb');
  mirror.fetch(WB, mirror.WHISPER_BASE);
  console.log('conversations');
  const two = conversation(['Daniel', 'Samantha'], [0, 1, 0, 1, 0, 1, 0], 0);
  const three = conversation(['Daniel', 'Samantha', 'Karen'], [], 180);
  const routes = Object.assign(mirror.routes([SEG, EMB, WB]), {
    '/__two.f32': () => Buffer.from(two.audio.buffer), '/__three.f32': () => Buffer.from(three.audio.buffer), '/__two.wav': () => wav16(two.audio)
  });
  await withPage({ headers: true, routes }, async (page) => {
    await mirror.attach(page, [SEG, EMB, WB]);
    await page.goto('/audio-to-text', 1500);
    const run = (name, speakers) => page.eval(`(async () => {
      const audio = new Float32Array(await (await fetch('/__${name}.f32')).arrayBuffer());
      const w = new Worker('/js/diarize-worker.js', { type: 'module' });
      const t0 = performance.now();
      const r = await new Promise((res, rej) => { w.onmessage = (e) => { if (e.data.type === 'done') res(e.data); if (e.data.type === 'error') rej(new Error(e.data.message)); }; w.postMessage({ type: 'run', audio, speakers: ${speakers} }, [audio.buffer]); });
      w.terminate();
      return { turns: r.turns, speakers: r.speakers, ms: performance.now() - t0 };
    })()`, 900000);
    const r2 = await run('two', 0), s2 = score(r2.turns, two.truth);
    ok(r2.speakers === 2 && s2 >= 0.94, `two people, ${two.secs.toFixed(0)} s: Auto found ${r2.speakers}, ${(s2 * 100).toFixed(1)}% of the speech labelled right, in ${(r2.ms / 1000).toFixed(1)} s`);
    const r3 = await run('three', 0), s3 = score(r3.turns, three.truth);
    ok(r3.speakers === 3 && s3 >= 0.90, `three people, ${three.secs.toFixed(0)} s: Auto found ${r3.speakers}, ${(s3 * 100).toFixed(1)}% right, in ${(r3.ms / 1000).toFixed(1)} s`);
    const r3n = await run('three', 3), s3n = score(r3n.turns, three.truth);
    ok(r3n.speakers === 3 && s3n >= 0.90, `three people, told 3: ${(s3n * 100).toFixed(1)}% right`);

    // The page, end to end.
    const p = await page.eval(`(async () => {
      const f = new File([await (await fetch('/__two.wav')).blob()], 'interview.wav', { type: 'audio/wav' });
      const dt = new DataTransfer(); dt.items.add(f);
      const inp = document.querySelector('#fileInput'); inp.files = dt.files; inp.dispatchEvent(new Event('change', { bubbles: true }));
      document.querySelector('#model').value = 'onnx-community/whisper-base';
      document.querySelector('#language').value = 'en';
      document.querySelector('#diarize').checked = true;
      document.querySelector('#convertBtn').click();
      for (let i = 0; i < 6000 && document.querySelector('#result').hidden; i++) await new Promise((r) => setTimeout(r, 100));
      const names = document.querySelector('#speakerNames');
      let srt = null; const o = CV.downloadBlob; CV.downloadBlob = (b) => { srt = b; };
      document.querySelector('#dlSrt').click(); CV.downloadBlob = o;
      return { text: document.querySelector('#transcript').value, boxes: names.querySelectorAll('input').length, srt: srt ? await srt.text() : '', status: document.querySelector('#status').textContent };
    })()`, 1200000);
    ok(/^Speaker 1: /.test(p.text) && /\n\nSpeaker 2: /.test(p.text) && p.boxes === 2, 'the page labels the transcript (' + p.boxes + ' name boxes): ' + JSON.stringify(p.text.slice(0, 120)));
    ok(/Speaker 1: /.test(p.srt) && /Speaker 2: /.test(p.srt), 'the SRT names the speakers at each change');
    if (page.logs.length) console.log('    console: ' + page.logs.slice(0, 3).join(' | '));
  });
}

browser().catch((e) => ok(false, 'browser: ' + (e.stack || e))).then(() => {
  if (failed) { console.log(`\n${failed} check(s) failed`); process.exit(1); }
  console.log('\ncheck-diarize: all good');
});
