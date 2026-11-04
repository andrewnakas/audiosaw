#!/usr/bin/env node
/*
 * Checks /censor-audio (js/censor.js + js/censor-page.js).
 *
 * Node: the word list (stems, whole words, the words it must not catch),
 * and ASCensor.apply (length unchanged, untouched outside the spans, a
 * 1 kHz bleep inside, no click at either edge).
 *
 * Browser (timestamped Whisper base from the local mirror, ffmpeg core from
 * the cache): two `say` voices speaking sentences with swear words laid in
 * at known times, 30 ms from the words either side, run through the real
 * page with mild words ticked.
 *   - every swear word is found, and nothing else is;
 *   - each bleep leaves at most 1% (-20 dB) of its word's energy audible;
 *   - no bleep reaches more than 300 ms into a neighbouring word (measured
 *     289: Whisper's word ends can be a quarter of a second late, and a
 *     bleep that runs over is the lesser mistake);
 *   - the written file is the same length, sample for sample, and identical
 *     outside the bleeps (float WAV, so no dither to blur the comparison);
 *   - a video comes back with its picture stream byte-identical (ffmpeg's
 *     md5 of the copied packets) and the same duration.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const C = require('../js/censor.js');

let failed = 0;
const ok = (c, m) => { console.log((c ? '  ok  ' : '  FAIL ') + m); if (!c) failed++; };

console.log('words');
{
  const yes = ['fucking', 'Bullshit,', 'motherfucker', 'shit.', 'asshole', 'bitch', 'f***', 'F**k', 'cunt'];
  const mild = ['damn', 'Hell,', 'crap', 'ass'];
  const no = ['hello', 'shell', 'class', 'assume', 'Scunthorpe', 'Fukushima', 'niggle', 'retardant', 'cocktail', 'Dickens', 'bloody', 'screw', 'Jesus', 'shiitake', 'passion'];
  ok(yes.every((w) => C.match(w) === 'strong'), 'strong words and their forms: ' + yes.map((w) => w + '=' + C.match(w)).filter((s) => !/strong$/.test(s)).join(' ') + '(all strong)');
  ok(mild.every((w) => C.match(w) === 'mild'), 'mild words are mild');
  const bad = no.filter((w) => C.match(w));
  ok(!bad.length, 'not caught: hello, class, Scunthorpe, Fukushima, cocktail, bloody, Jesus… ' + (bad.length ? '(caught ' + bad.join(', ') + ')' : ''));
  ok(C.match('Gary', { custom: ['gary'] }) === 'custom', 'a custom word is matched');
}

console.log('apply');
{
  const R = 48000, n = 2 * R, L = new Float32Array(n), Rr = new Float32Array(n);
  for (let i = 0; i < n; i++) { L[i] = 0.3 * Math.sin(2 * Math.PI * 200 * i / R); Rr[i] = 0.2 * Math.sin(2 * Math.PI * 300 * i / R); }
  const [oL, oR] = C.apply([L, Rr], R, [[0.5, 0.8]], { mode: 'bleep' });
  const a = Math.round(0.5 * R), b = Math.round(0.8 * R);
  let same = oL.length === n;
  for (let i = 0; i < n && same; i++) if ((i < a || i >= b) && (oL[i] !== L[i] || oR[i] !== Rr[i])) same = false;
  ok(same, 'same length, untouched outside the span');
  // 1 kHz dominates the middle of the span.
  const g = (x, f, from, len) => { let re = 0, im = 0; for (let i = 0; i < len; i++) { re += x[from + i] * Math.cos(2 * Math.PI * f * i / R); im += x[from + i] * Math.sin(2 * Math.PI * f * i / R); } return Math.hypot(re, im) * 2 / len; };
  const mid = a + 2400, k1 = g(oL, 1000, mid, 4800), k2 = g(oL, 200, mid, 4800);
  ok(k1 > 0.2 && k2 < 1e-3, 'the middle is a bleep at the word\'s level (1 kHz ' + k1.toFixed(3) + ', original 200 Hz ' + k2.toExponential(1) + ')');
  let step = 0, inStep = 0;
  for (let i = 1; i < n; i++) { step = Math.max(step, Math.abs(oL[i] - oL[i - 1])); inStep = Math.max(inStep, Math.abs(L[i] - L[i - 1])); }
  ok(step < 0.03 + inStep, 'no click at either edge (largest step ' + step.toFixed(4) + ', the bleep itself moves 0.031 a sample)');
  const [sL] = C.apply([L], R, [[0.5, 0.8]], { mode: 'silence' });
  let pk = 0; for (let i = a + 240; i < b - 240; i++) pk = Math.max(pk, Math.abs(sL[i]));
  ok(pk === 0, 'silence mode is digital silence between the fades');
}

async function browser() {
  const { withPage, findChrome } = require('./chrome-harness');
  const mirror = require('./model-mirror'), M = 'onnx-community/whisper-base_timestamped';
  try { execFileSync('say', ['-v', '?'], { stdio: 'ignore' }); execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); } catch (e) { console.log('  skip: needs say and ffmpeg'); return; }
  if (!findChrome() || !mirror.has(M, mirror.WHISPER_BASE)) { console.log('  skip: whisper-base_timestamped is not in the mirror'); return; }
  console.log('page');
  const CORE = path.join(os.homedir(), '.cache', 'audiosaw', 'ffmpeg-core-0.12.6.wasm');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'as-censor-'));
  const R = 48000, GAP = 0.03;
  // [text, isSwear]. Swear words are their own clips so their times are known.
  const script = [
    ['Samantha', [['What the', 0], ['hell', 1], ['is this? That was a', 0], ['damn', 1], ['good game, and he is such an', 0], ['asshole', 1], ['and I did not see that coming.', 0], ['Fucking', 1], ['unbelievable. We will try again tomorrow.', 0]]],
    ['Daniel', [['This whole plan is', 0], ['bullshit', 1], ['so where did you put the keys? Stop being a', 0], ['bitch', 1], ['about it. The', 0], ['bastard', 1], ['took my parking spot, holy', 0], ['shit', 1], ['what a morning.', 0]]]
  ];
  function clip(voice, text, name) {
    const a = path.join(dir, name + '.aiff'), b = path.join(dir, name + '.raw');
    execFileSync('say', ['-v', voice, '-o', a, text]);
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', a, '-af', 'silenceremove=start_periods=1:start_threshold=-45dB:stop_periods=-1:stop_threshold=-45dB:stop_duration=0.05,aresample=' + R, '-ac', '1', '-f', 'f32le', b]);
    const buf = fs.readFileSync(b);
    return new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4).slice();
  }
  const cases = script.map(([voice, parts]) => {
    const pieces = [], swears = [], others = []; let t = 0.4;
    parts.forEach(([text, sw], k) => {
      const x = clip(voice, text, voice + k), span = [t, t + x.length / R];
      (sw ? swears : others).push(span);
      pieces.push([Math.round(t * R), x]);
      t += x.length / R + GAP;
    });
    const a = new Float32Array(Math.round((t + 0.4) * R));
    pieces.forEach(([o, x]) => a.set(x, o));
    const wav = path.join(dir, voice + '.wav');
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'f32le', '-ar', String(R), '-ac', '1', '-i', '-', '-c:a', 'pcm_f32le', wav], { input: Buffer.from(a.buffer) });
    return { voice, wav, swears, others, samples: a };
  });

  const routes = Object.assign(mirror.routes([M]), fs.existsSync(CORE) ? { '/__core.wasm': () => fs.readFileSync(CORE) } : {});
  await withPage({ routes }, async (page) => {
    await mirror.attach(page, [M]);
    if (fs.existsSync(CORE)) {
      page.listen('Fetch.requestPaused', (p) => { if (/ffmpeg-core\.wasm/.test(p.request.url)) page.send('Fetch.continueRequest', { requestId: p.requestId, url: page.url('/__core.wasm') }); });
    }
    await page.goto('/censor-audio', 1500);
    let found = 0, total = 0, falseHits = 0, worstLeak = -Infinity, worstSpill = 0;
    for (const c of cases) {
      const b64 = fs.readFileSync(c.wav).toString('base64');
      const r = await page.eval(`(async () => {
        const bin = atob('${b64}'); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
        document.getElementById('mild').checked = true;
        window.__censor.use(new File([u], '${c.voice}.wav', { type: 'audio/wav' }));
        await window.__censor.analyse();
        const W = window.__censor.words(); const marks = window.__censor.marks().filter((m) => m.on).map((m) => ({ text: m.text, start: m.start, end: m.end, w0: W[m.at].start, w1: W[m.at].end }));
        document.getElementById('format').value = 'wav32f';
        let out = null; const orig = CV.downloadBlob; CV.downloadBlob = (b, n) => { out = b; };
        await window.__censor.clean();
        CV.downloadBlob = orig;
        if (!out) return { marks, err: document.getElementById('status').textContent };
        const ab = await out.arrayBuffer();
        const dv = new DataView(ab); let off = 12, data = null;
        while (off < ab.byteLength - 8) { const id = String.fromCharCode(dv.getUint8(off), dv.getUint8(off+1), dv.getUint8(off+2), dv.getUint8(off+3)); const sz = dv.getUint32(off + 4, true); if (id === 'data') { data = new Float32Array(ab.slice(off + 8, off + 8 + sz)); break; } off += 8 + sz + (sz & 1); }
        return { marks, out: Array.from(data || []) };
      })()`, 900000);
      if (r.err) { ok(false, c.voice + ': ' + r.err); continue; }
      if (process.env.CENSOR_DUMP) {
        const d = await page.eval('({ words: window.__censor.words(), mono: Array.from(window.__censor.mono16()) })');
        fs.writeFileSync(path.join(process.env.CENSOR_DUMP, c.voice + '.json'), JSON.stringify({ words: d.words, mono: d.mono, swears: c.swears, others: c.others, samples: Array.from(c.samples.filter((_, i) => i % 3 === 0)) }));
      }
      const words = r.marks.map((m) => m.text).join(', ');
      for (const sw of c.swears) {
        total++;
        const m = r.marks.find((k) => k.end > sw[0] && k.start < sw[1]);
        if (!m) continue;
        found++;
        // Energy of the word left outside the bleep.
        let all = 0, left = 0;
        for (let i = Math.round(sw[0] * R); i < Math.round(sw[1] * R); i++) {
          const e = c.samples[i] * c.samples[i]; all += e;
          if (i / R < m.start || i / R >= m.end) left += e;
        }
        const lk = 10 * Math.log10(Math.max(left, 1e-12) / all);
        if (process.env.CENSOR_DEBUG) console.log('       ' + m.text + ': truth ' + sw[0].toFixed(2) + '-' + sw[1].toFixed(2) + ' bleep ' + m.start.toFixed(2) + '-' + m.end.toFixed(2) + ' whisper ' + (m.w0 != null ? m.w0.toFixed(2) + '-' + m.w1.toFixed(2) : '') + ' leak ' + lk.toFixed(1));
        worstLeak = Math.max(worstLeak, lk);
        for (const o of c.others) worstSpill = Math.max(worstSpill, Math.min(m.end, o[1]) - Math.max(m.start, o[0]));
      }
      falseHits += r.marks.filter((m) => !c.swears.some((sw) => m.end > sw[0] && m.start < sw[1])).length;
      // Same length, and untouched outside the bleeps.
      let same = r.out.length === c.samples.length, diff = 0;
      for (let i = 0; i < c.samples.length && same; i++) {
        const t = i / R;
        if (r.marks.some((m) => t >= m.start - 0.001 && t < m.end + 0.001)) continue;
        diff = Math.max(diff, Math.abs(r.out[i] - c.samples[i]));
      }
      ok(same && diff < 1e-6, c.voice + ': same length (' + r.out.length + ' samples), untouched outside the bleeps (max difference ' + diff.toExponential(1) + '); marked: ' + words);
    }
    ok(found === total, 'every swear word found: ' + found + ' of ' + total);
    ok(falseHits === 0, 'nothing else bleeped (' + falseHits + ')');
    ok(worstLeak <= -20, 'at most 1% of any word left audible (worst ' + worstLeak.toFixed(1) + ' dB)');
    ok(worstSpill <= 0.3, 'no bleep more than 300 ms into a neighbouring word (worst ' + Math.round(worstSpill * 1000) + ' ms)');
    console.log('       (measured: leak ' + worstLeak.toFixed(1) + ' dB, spill ' + Math.round(worstSpill * 1000) + ' ms)');

    if (fs.existsSync(CORE)) {
      const c = cases[0], mp4 = path.join(dir, 'v.mp4');
      execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25', '-i', c.wav, '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', mp4]);
      const b64 = fs.readFileSync(mp4).toString('base64');
      const r = await page.eval(`(async () => {
        const bin = atob('${b64}'); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
        window.__censor.use(new File([u], 'v.mp4', { type: 'video/mp4' }));
        await window.__censor.analyse();
        let out = null, name = null; const orig = CV.downloadBlob; CV.downloadBlob = (b, n) => { out = b; name = n; };
        await window.__censor.clean();
        CV.downloadBlob = orig;
        if (!out) return { err: document.getElementById('status').textContent };
        const ab = new Uint8Array(await out.arrayBuffer()); let s = ''; for (let i = 0; i < ab.length; i += 0x8000) s += String.fromCharCode.apply(null, ab.subarray(i, i + 0x8000));
        return { name, b64: btoa(s), n: window.__censor.marks().filter((m) => m.on).length };
      })()`, 900000);
      if (r.err) ok(false, 'video: ' + r.err);
      else {
        const outF = path.join(dir, 'out.mp4');
        fs.writeFileSync(outF, Buffer.from(r.b64, 'base64'));
        const md5 = (f) => execFileSync('ffmpeg', ['-loglevel', 'error', '-i', f, '-map', '0:v', '-c', 'copy', '-f', 'md5', '-']).toString().trim();
        const dur = (f, s) => +execFileSync('ffprobe', ['-v', 'error', '-select_streams', s, '-show_entries', 'stream=duration', '-of', 'csv=p=0', f]).toString().trim();
        ok(md5(outF) === md5(mp4) && Math.abs(dur(outF, 'v:0') - dur(mp4, 'v:0')) < 0.001 && r.n >= 4,
          'video: ' + r.name + ', ' + r.n + ' words bleeped, picture byte-identical (' + md5(outF).slice(4, 14) + '…), ' + dur(outF, 'v:0').toFixed(2) + ' s');
      }
    } else console.log('  skip: video (no ffmpeg core in the cache)');
    const errs = page.logs.filter((l) => !/scriptwrapper|ERR_CONNECTION_REFUSED|favicon/.test(l));
    ok(!errs.length, 'no page errors' + (errs.length ? ': ' + errs.join(' | ').slice(0, 300) : ''));
  });
}

browser().then(() => {
  if (failed) { console.log('\ncheck-censor: ' + failed + ' failed'); process.exit(1); }
  console.log('\ncheck-censor: all good');
}).catch((e) => { console.error(e); process.exit(1); });
