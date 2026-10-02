#!/usr/bin/env node
/*
 * /record-computer-audio in headless Chrome, recording a real tab.
 *
 * Chrome is started without the fake media flags and with
 * --auto-select-tab-capture-source-by-title, so getDisplayMedia skips its
 * picker and shares the tab with that title: a second tab playing 440 Hz on
 * the left and 660 Hz on the right at half of full scale. That is a real tab
 * capture through Chrome's own path, the same one a visitor gets.
 *
 * It asserts:
 *   1. The browser's default (`audio: true`) is the call-style path the page
 *      describes: mono, echo cancellation on, the tone well below its level.
 *   2. The page's recording is stereo, 32-bit float, the length of the time
 *      it ran, each tone on its own channel at its own level, and nothing
 *      else in it beyond float rounding. The readout names it as tab audio
 *      and convert_success fires. MP3 also saves.
 *   3. A share without sound, a cancelled picker and a silent tab each get
 *      their own message, fire no convert_error, and leave nothing shared.
 *   4. The shared tab closing (the browser ending the share) keeps the
 *      recording made so far.
 *   5. A browser with no getDisplayMedia, and Firefox, are told so up front.
 *
 *   node tools/check-record-computer.js
 */
const { findChrome, withPage } = require('./chrome-harness');

if (!findChrome()) { console.log('check-record-computer: no Chrome found, skipped.'); process.exit(0); }

const TITLE = 'AS tone source';
// The tab plays a one-second loop computed here rather than oscillators, so
// the recording can be compared with exactly what was played, sample for
// sample. One second holds a whole number of 440 and 660 Hz cycles at any
// rate the context opens at.
const SOURCE = `<!doctype html><title>${TITLE}</title><body>tone<script>
  window.start = async (amp) => {
    const c = new AudioContext(), n = c.sampleRate;
    const b = c.createBuffer(2, n, n);
    [440, 660].forEach((f, ch) => { const d = b.getChannelData(ch); for (let i = 0; i < n; i++) d[i] = 0.5 * Math.sin(2 * Math.PI * f * i / n); });
    const s = c.createBufferSource(); s.buffer = b; s.loop = true;
    window.gain = c.createGain(); window.gain.gain.value = amp / 0.5;
    s.connect(window.gain); window.gain.connect(c.destination); s.start();
    await c.resume();
    window.ctx = c; window.loop = [b.getChannelData(0), b.getChannelData(1)];
    return n;
  };
  window.setAmp = (a) => { window.gain.gain.value = a / 0.5; };
</script></body>`;

const fails = [];
const notes = [];
function ok(cond, msg) { if (!cond) fails.push(msg); }

// Runs in the recorder page. Shared helpers for every step.
const HELPERS = `
  window.__h = window.__h || (() => {
    const $ = (s) => document.querySelector(s);
    const wait = async (fn, ms) => { const e = Date.now() + (ms || 15000); while (!fn()) { if (Date.now() > e) throw new Error('timeout waiting for ' + fn + ' — status: ' + $('#status').textContent); await new Promise((r) => setTimeout(r, 50)); } };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const events = () => (window.dataLayer || []).filter((a) => a && a[0] === 'event').map((a) => a[1]);
    // Float WAV reader, written apart from the writer in audio-core.js.
    function readWav(ab) {
      const v = new DataView(ab); let p = 12, fmt = null;
      while (p + 8 <= v.byteLength) {
        const id = String.fromCharCode(v.getUint8(p), v.getUint8(p + 1), v.getUint8(p + 2), v.getUint8(p + 3)), n = v.getUint32(p + 4, true);
        if (id === 'fmt ') fmt = { tag: v.getUint16(p + 8, true), ch: v.getUint16(p + 10, true), rate: v.getUint32(p + 12, true), bits: v.getUint16(p + 22, true) };
        if (id === 'data') {
          const frames = n / (fmt.ch * fmt.bits / 8), chans = [];
          for (let c = 0; c < fmt.ch; c++) chans.push(new Float32Array(frames));
          for (let i = 0; i < frames; i++) for (let c = 0; c < fmt.ch; c++) chans[c][i] = v.getFloat32(p + 8 + (i * fmt.ch + c) * 4, true);
          return { fmt, chans };
        }
        p += 8 + n + (n & 1);
      }
      throw new Error('no data chunk');
    }
    // Least-squares fit of a sine at a known frequency: amplitude, and the
    // residual relative to the signal in dB.
    function fit(x, hz, rate) {
      let ss = 0, cc = 0, sc = 0, xs = 0, xc = 0;
      for (let i = 0; i < x.length; i++) { const w = 2 * Math.PI * hz * i / rate, s = Math.sin(w), c = Math.cos(w); ss += s * s; cc += c * c; sc += s * c; xs += x[i] * s; xc += x[i] * c; }
      const det = ss * cc - sc * sc, a = (xs * cc - xc * sc) / det, b = (xc * ss - xs * sc) / det;
      let res = 0, sig = 0;
      for (let i = 0; i < x.length; i++) { const w = 2 * Math.PI * hz * i / rate, m = a * Math.sin(w) + b * Math.cos(w); res += (x[i] - m) * (x[i] - m); sig += m * m; }
      return { amp: Math.hypot(a, b), residualDb: 10 * Math.log10(res / sig) };
    }
    // Recording happens across three steps, because Chrome moves the focus
    // to the shared tab and a hidden page's timers are held to once a second:
    // begin() starts it, Node brings the page back and waits, end() stops it.
    // The start is stamped by a MutationObserver, which no throttling delays.
    // Where the recording sits in the tab's loop, and how far any sample is
    // from the one the tab played there.
    function compare(chans, loop, rate) {
      const n = loop[0].length, start = chans[0].findIndex((v, i) => i > 4096 && v !== 0);
      let off = -1, best = Infinity;
      for (let k = 0; k < n; k++) {
        let e = 0;
        for (let j = 0; j < 64 && e < best; j++) for (let c = 0; c < 2; c++) e += Math.abs(chans[c][start + j] - loop[c][(k + j) % n]);
        if (e < best) { best = e; off = k; }
      }
      if (best > 1e-3) off = -1;
      if (off < 0) return { found: false };
      let worst = 0, differ = 0, last = 0;
      for (let i = start; i < chans[0].length; i++) {
        for (let c = 0; c < 2; c++) {
          const e = Math.abs(chans[c][i] - loop[c][(off + i - start) % n]);
          if (e > worst) worst = e;
          if (e) { differ++; last = i; }
        }
      }
      return { found: true, compared: chans[0].length - start, worst, worstDb: 20 * Math.log10(worst || 1e-30), differ, lastDiffAt: last / rate };
    }
    async function begin() {
      $('#resetBtn').click();
      window.__t0 = 0;
      const mo = new MutationObserver(() => { if (!$('#stopBtn').disabled && !window.__t0) window.__t0 = performance.now(); });
      mo.observe($('#stopBtn'), { attributes: true });
      $('#recordBtn').click();
      await wait(() => window.__t0 || /status (warn|error)/.test($('#status').className));
      mo.disconnect();
      return !!window.__t0;
    }
    async function end() {
      const meter = parseFloat($('#meterBar').style.width) || 0, size = $('#recSize').textContent;
      const t1 = performance.now();
      $('#stopBtn').click();
      await wait(() => $('#controls').style.display === '' || /status (warn|error)/.test($('#status').className));
      return { secs: (t1 - window.__t0) / 1000, meter, size, status: $('#status').textContent };
    }
    async function save(fmt, br) {
      let out = null; const o = CV.downloadBlob;
      CV.downloadBlob = function (b, n) { out = { b, n }; return o.apply(this, arguments); };
      $('#outFmt').value = fmt; if (br) $('#bitrate').value = br;
      $('#saveBtn').click();
      await wait(() => out, 60000); CV.downloadBlob = o;
      await wait(() => !$('[data-sig="out"]') || !$('[data-sig="out"]').hidden, 5000).catch(() => {});
      const bytes = new Uint8Array(await out.b.arrayBuffer());
      return { name: out.n, bytes, sniff: AudioSaw.sniffFormat(bytes) };
    }
    return { $, wait, sleep, events, readWav, fit, compare, begin, end, save };
  })();
`;

(async () => {
  await withPage({ fakeMedia: false, routes: { '/__src': SOURCE }, args: ['--auto-select-tab-capture-source-by-title=' + TITLE] }, async (page) => {
    // A user gesture on every call: window.open and getDisplayMedia want one.
    // Chrome moves the focus to a tab when it starts being shared, as it does
    // for a visitor, and getDisplayMedia refuses an unfocused page
    // (InvalidStateError), so the recorder is brought back before each step.
    const run = async (expr, timeout) => {
      await page.send('Page.bringToFront');
      await new Promise((r) => setTimeout(r, 200));
      const res = await page.send('Runtime.evaluate', { expression: HELPERS + expr, awaitPromise: true, returnByValue: true, userGesture: true, timeout: timeout || 120000 });
      if (res.result && res.result.exceptionDetails) {
        const ex = res.result.exceptionDetails;
        throw new Error((ex.exception && ex.exception.description) || JSON.stringify(ex).slice(0, 600));
      }
      return res.result.result.value;
    };

    await page.goto('/record-computer-audio', 1200);
    const recNote = await page.eval(`document.getElementById('recNote').textContent`);
    if (process.platform === 'darwin') ok(/On a Mac/.test(recNote), 'on a Mac the note under Record says: ' + recNote);
    if (process.platform === 'win32') ok(/Also share system audio/.test(recNote), 'on Windows the note under Record says: ' + recNote);
    const srcRate = await run(`(async () => {
      window.__src = window.open('/__src', '_blank');
      await __h.wait(() => window.__src && window.__src.start, 10000);
      return window.__src.start(0.5);
    })()`);

    // 1. What Chrome hands over when a page just asks for "audio".
    const d = await run(`(async () => {
      const st = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      const a = st.getAudioTracks()[0], s = a.getSettings();
      const c = new AudioContext(); const an = c.createAnalyser(); an.fftSize = 2048;
      c.createMediaStreamSource(new MediaStream([a])).connect(an);
      let peak = 0; const buf = new Float32Array(2048);
      for (let i = 0; i < 20; i++) { await __h.sleep(50); an.getFloatTimeDomainData(buf); for (const x of buf) peak = Math.max(peak, Math.abs(x)); }
      st.getTracks().forEach((t) => t.stop()); c.close();
      return { label: a.label, ch: s.channelCount, rate: s.sampleRate, ec: s.echoCancellation, ns: s.noiseSuppression, agc: s.autoGainControl, peak };
    })()`);
    ok(d.ch === 1 && d.ec && d.ns && d.agc && d.peak < 0.45,
      'Chrome\'s default tab audio is no longer mono with call processing (' + JSON.stringify(d) + '); the page and record-computer-page.js say it is');
    notes.push('Chrome\'s default for tab audio: ' + d.ch + ' channel, ' + (d.rate / 1000) + ' kHz, echo cancellation/noise suppression/AGC ' + [d.ec, d.ns, d.agc].join('/') + ', a 0.5 tone peaked at ' + d.peak.toFixed(3));

    // 2. The page's own recording.
    const began = await run(`__h.begin()`);
    let r = { err: 'Record did not start' };
    if (began) {
      await page.send('Page.bringToFront');
      await new Promise((res) => setTimeout(res, 3000));
      r = await run(`(async () => {
        const rec = await __h.end();
        const sig = __h.$('#signalPath') ? __h.$('#signalPath').textContent : '';
        const wav = await __h.save('wav');
        const w = __h.readWav(wav.bytes.buffer);
        const rate = w.fmt.rate, skip = Math.round(rate * 0.2);
        const mid = (x) => x.subarray(skip, x.length - skip);
        const L = mid(w.chans[0]), R = mid(w.chans[1] || w.chans[0]);
        const fits = { L440: __h.fit(L, 440, rate), R660: __h.fit(R, 660, rate), L660: __h.fit(L, 660, rate), R440: __h.fit(R, 440, rate) };
        const exact = __h.compare(w.chans, window.__src.loop, rate);
        const sigOut = __h.$('#signalPath') ? __h.$('#signalPath').textContent : '';
        const mp3 = await __h.save('mp3', '320');
        let dump = null;
        if (${JSON.stringify(!!process.env.RC_DUMP)}) { let s = ''; for (let i = 0; i < wav.bytes.length; i += 32768) s += String.fromCharCode.apply(null, wav.bytes.subarray(i, i + 32768)); dump = btoa(s); }
        return { rec, sig, sigOut, name: wav.name, sniff: wav.sniff, fmt: w.fmt, secs: w.chans[0].length / rate,
          fits, exact, mp3: mp3.sniff, events: __h.events(), dump };
      })()`, 180000);
      if (r.dump) { require('fs').writeFileSync(process.env.RC_DUMP, Buffer.from(r.dump, 'base64')); notes.push('wrote ' + process.env.RC_DUMP); }
    }
    if (r.err) {
      fails.push('the page did not start recording the tab: ' + r.err);
    } else {
      ok(r.sniff && r.sniff.float && r.sniff.bits === 32 && r.sniff.channels === 2, 'WAV "match the source" saved as ' + JSON.stringify(r.sniff) + ' (want stereo 32-bit float)');
      ok(r.fmt.tag === 3 && r.fmt.rate === srcRate, 'the file is format ' + r.fmt.tag + ' at ' + r.fmt.rate + ' Hz; the tab played at ' + srcRate + ' Hz');
      ok(Math.abs(r.secs - r.rec.secs) < 0.25, 'recorded ' + r.secs.toFixed(3) + ' s for ' + r.rec.secs.toFixed(3) + ' s of recording');
      ok(Math.abs(r.fits.L440.amp - 0.5) < 0.0005 && Math.abs(r.fits.R660.amp - 0.5) < 0.0005, 'tone levels came back as L ' + r.fits.L440.amp + ', R ' + r.fits.R660.amp + ' (played at 0.5)');
      // Not bit-exact: Chrome's capture path leaves a few float32 rounding
      // steps (measured worst 1.5e-7, -136.5 dB). Anything a real processing
      // stage would do is orders of magnitude larger.
      ok(r.exact.found && r.exact.worst < 1e-6, 'the recording is not the samples the tab played: ' + JSON.stringify(r.exact));
      ok(r.fits.L660.amp < 0.001 && r.fits.R440.amp < 0.001, 'channels leak into each other: 660 Hz on the left ' + r.fits.L660.amp + ', 440 Hz on the right ' + r.fits.R440.amp);
      ok(r.rec.meter > 10, 'the level meter sat at ' + r.rec.meter + '% while a 0.5 tone played');
      ok(/MB|KB/.test(r.rec.size), 'no size shown while recording: "' + r.rec.size + '"');
      ok(/stereo/.test(r.rec.status) && /32-bit float/.test(r.rec.status), 'status after stop: ' + r.rec.status);
      ok(/Tab audio/.test(r.sig) && /32-bit float/.test(r.sig) && /stereo/.test(r.sig), 'readout "Your file" says: ' + r.sig);
      ok(/Saved as/.test(r.sigOut) && /float/i.test(r.sigOut), 'readout "Saved as" says: ' + r.sigOut);
      ok(/^tab-audio-.*\.wav$/.test(r.name), 'file name ' + r.name);
      ok(r.mp3 && r.mp3.container === 'mp3', 'MP3 saved as ' + JSON.stringify(r.mp3));
      ok(r.events.filter((e) => e === 'convert_success').length === 2, 'convert_success fired ' + r.events.filter((e) => e === 'convert_success').length + ' times for two saves');
      ok(!r.events.includes('convert_error'), 'a clean recording fired convert_error');
      notes.push('tab capture: stereo ' + (r.fmt.rate / 1000) + ' kHz float, levels ' + r.fits.L440.amp.toFixed(6) + '/' + r.fits.R660.amp.toFixed(6) +
        ', every sample within ' + r.exact.worst.toExponential(2) + ' (' + r.exact.worstDb.toFixed(1) + ' dB) of what the tab played over ' + r.exact.compared + ' frames, crosstalk ' + Math.max(r.fits.L660.amp, r.fits.R440.amp).toExponential(1) +
        ', ' + r.secs.toFixed(2) + ' s for ' + r.rec.secs.toFixed(2) + ' s');
    }

    // 3. Shares that cannot be recorded. Each starts from a focused page.
    const evBefore = await run(`__h.events().length`);
    // The "Also share tab audio" switch left off: a share with no audio track.
    const noAudio = await run(`(async () => {
      const md = navigator.mediaDevices, real = md.getDisplayMedia.bind(md);
      let last = null;
      md.getDisplayMedia = (o) => real(Object.assign({}, o, { audio: false })).then((st) => (last = st));
      await __h.begin();
      md.getDisplayMedia = real;
      await __h.sleep(100);
      return { status: __h.$('#status').textContent, cls: __h.$('#status').className, live: last ? last.getTracks().filter((t) => t.readyState === 'live').length : -1, rec: !__h.$('#recordBtn').disabled };
    })()`);
    ok(/Also share tab audio/.test(noAudio.status) && /warn/.test(noAudio.cls), 'a share without audio said: ' + noAudio.status);
    ok(noAudio.live === 0, 'a share without audio left ' + noAudio.live + ' track(s) live');
    ok(noAudio.rec, 'Record is not available again after a share without audio');
    // The picker cancelled.
    const cancel = await run(`(async () => {
      const md = navigator.mediaDevices, real = md.getDisplayMedia;
      md.getDisplayMedia = () => Promise.reject(new DOMException('Permission denied by user', 'NotAllowedError'));
      await __h.begin();
      md.getDisplayMedia = real;
      return { status: __h.$('#status').textContent, cls: __h.$('#status').className };
    })()`);
    ok(/cancelled/.test(cancel.status) && /warn/.test(cancel.cls), 'a cancelled picker said: ' + cancel.status);
    // A tab with nothing playing.
    await run(`window.__src.setAmp(0), __h.sleep(300)`);
    if (await run(`__h.begin()`)) {
      await page.send('Page.bringToFront');
      await new Promise((res) => setTimeout(res, 800));
      const silent = await run(`__h.end()`);
      ok(/every sample is silent/.test(silent.status), 'a silent tab said: ' + silent.status);
    } else fails.push('a silent tab did not start recording');
    await run(`window.__src.setAmp(0.5)`);
    const missEvents = await run(`__h.events().slice(${evBefore})`);
    ok(!missEvents.includes('convert_error'), 'a user-side miss fired convert_error: ' + missEvents.join(','));

    // 4. The browser ends the share: here, the shared tab closes.
    if (await run(`__h.begin()`)) {
      await page.send('Page.bringToFront');
      await new Promise((res) => setTimeout(res, 1500));
      // Timed at the close, not when the status appears: the page's
      // "Recorded m:ss" is floored, and the time it takes to notice the
      // share ended and finish the file is not recording. Comparing the
      // floored text with the later clock failed at 1.9 s recorded vs 2.02 s.
      // The saved file's exact length is what shows whether audio was lost.
      const end = await run(`(async () => {
        const secs = (performance.now() - window.__t0) / 1000;
        window.__src.close();
        await __h.wait(() => __h.$('#controls').style.display === '' || /status (warn|error)/.test(__h.$('#status').className), 10000);
        const st = { status: __h.$('#status').textContent, stopDisabled: __h.$('#stopBtn').disabled, secs };
        try { const wav = await __h.save('wav'); const w = __h.readWav(wav.bytes.buffer); st.fileSecs = w.chans[0].length / w.fmt.rate; } catch (e) { st.fileErr = String(e); }
        return st;
      })()`, 60000);
      ok(/share ended from the browser/.test(end.status) && end.stopDisabled, 'when the shared tab closed the page said: ' + end.status);
      ok(end.fileSecs != null && Math.abs(end.fileSecs - end.secs) < 0.25, 'when the shared tab closed after ' + end.secs.toFixed(2) + ' s the saved file holds ' + (end.fileSecs != null ? end.fileSecs.toFixed(2) + ' s' : 'nothing (' + end.fileErr + ')'));
    } else fails.push('the tab-closing case did not start recording');

    // 5. Browsers that cannot do it are told before they try.
    const added = await page.send('Page.addScriptToEvaluateOnNewDocument', { source: 'delete MediaDevices.prototype.getDisplayMedia;' });
    await page.goto('/record-computer-audio', 1000);
    const none = await page.eval(`({ note: document.getElementById('browserNote').textContent, disabled: document.getElementById('recordBtn').disabled })`);
    ok(/Chrome or Edge/.test(none.note) && none.disabled, 'with no getDisplayMedia the page said "' + none.note + '", Record disabled: ' + none.disabled);
    await page.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: added.result.identifier });
    await page.send('Network.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:131.0) Gecko/20100101 Firefox/131.0' });
    await page.goto('/record-computer-audio', 1000);
    const ff = await page.eval(`document.getElementById('browserNote').textContent`);
    ok(/Firefox/.test(ff) && /never its sound/.test(ff), 'Firefox was told: "' + ff + '"');

    ok(!page.logs.length, 'page errors: ' + page.logs.join(' | '));
  });

  if (fails.length) {
    fails.forEach((f) => console.error('  FAIL ' + f));
    notes.forEach((n) => console.error('  note: ' + n));
    console.error('check-record-computer: ' + fails.length + ' failure(s).');
    process.exit(1);
  }
  notes.forEach((n) => console.log('  ' + n));
  console.log('check-record-computer: a real tab recorded through /record-computer-audio is the tone that played, stereo, float, the right length; the misses are explained.');
})().catch((e) => { console.error('check-record-computer: ' + (e.stack || e)); process.exit(1); });
