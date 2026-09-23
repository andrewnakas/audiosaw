#!/usr/bin/env node
/*
 * Checks the round trip between the audio editor and a tool page
 * (js/project-link.js + js/editor-link.js) in headless Chrome, driving the real
 * pages the way a person would:
 *
 *   1. build a two-clip project in /audio-editor and send the first clip to
 *      /audio-reverser
 *   2. on the tool page, take the project audio, run the tool, send it back
 *   3. back in the editor, the project was restored without asking, the clip
 *      now plays the reversed audio (correlation with the reversed original
 *      > 0.99), its length is unchanged and the next clip has not moved
 *   4. one undo brings the original audio back
 *   5. a length-changing tool (/audio-speed at 2x) ripples the next clip in by
 *      the time it saved
 *   6. a same-length tool that outputs MP3 (/noise-reduction) comes back lined
 *      up: lamejs's encoder delay is measured and trimmed, so the result
 *      correlates with what was sent at zero lag
 *   6b. stems come back as a zip: the first replaces the clip, the other goes
 *      on a new track below at the same start, and one undo removes both
 *   6c. a second editor tab does not autosave, and "use this tab instead"
 *      moves ownership across
 *   6d. a range on one track comes back into exactly that range
 *   6e. the whole mix comes back as one bounce track, the originals cleared
 *      in that range, and one undo restores them
 *   7. a clip edited while the tool was open is not silently replaced: the
 *      editor asks
 *
 *   node tools/check-project-link.js
 *
 * Needs Google Chrome. Skips (exit 0) when it cannot find it.
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CHROME = [
  process.env.CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'
].filter(Boolean).find((p) => fs.existsSync(p));

if (!CHROME) {
  console.log('check-project-link: skipped (no Chrome found; set CHROME=/path/to/chrome to run it).');
  process.exit(0);
}

const TYPES = { '.js': 'application/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {
  let url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/') url = '/index.html';
  let file = path.join(ROOT, url);
  if (!path.extname(file) && fs.existsSync(file + '.html')) file += '.html';
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

const fails = [];
const notes = [];
function ok(cond, msg) { if (!cond) fails.push(msg); }

server.listen(0, '127.0.0.1', async () => {
  const origin = 'http://127.0.0.1:' + server.address().port;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'as-link-'));
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + dir,
    '--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore' });
  let code = 1;
  try {
    const cdp = await connect(dir);
    await cdp.send('Page.enable');
    await cdp.send('Network.enable');
    // Nothing leaves the machine: analytics and fonts are not what is under test.
    await cdp.send('Network.setBlockedURLs', { urls: ['*googletagmanager*', '*google-analytics*', '*fonts.googleapis*', '*fonts.gstatic*', '*unpkg.com*'] });
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'deny' }).catch(() => {});
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      // Service worker off: it would serve cached copies across the steps.
      source: 'try { Object.defineProperty(navigator, "serviceWorker", { value: undefined }); } catch (e) {}'
    });
    const run = makeRunner(cdp, origin);
    await scenario(run);
    if (fails.length) {
      fails.forEach((f) => console.error('  FAIL ' + f));
      console.error('check-project-link: ' + fails.length + ' failure(s).');
    } else {
      notes.forEach((n) => console.log('  ' + n));
      console.log('check-project-link: editor -> tool -> editor round trip holds (replace, undo, ripple, encoder-delay alignment, stems, one owner across tabs, ranges, mix bounce, stale clip).');
      code = 0;
    }
    cdp.close();
  } catch (e) {
    fails.forEach((f) => console.error('  FAIL ' + f));
    console.error('check-project-link: ' + (e.stack || e.message));
  }
  chrome.kill();
  server.close();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  process.exit(code);
});

/* ------------------------------------------------------------ scenario */

async function scenario(r) {
  // 1. A project: a 2 s chirp, then a 1 s tone straight after it on track 1.
  await r.open('/audio-editor');
  await r.waitFor('!!window.ASEditLink && !!document.getElementById("fileInput")');
  await r.eval(`(${inPage.makeFiles})()`);
  await r.waitFor('!document.getElementById("edSheet").hidden');
  await r.eval('document.querySelector(\'#edSheet [data-v="end"]\').click()');
  await r.waitSaved();
  let p = await r.project();
  let clips = p.tracks[0].clips;
  ok(clips.length === 2, 'the fixture project has two clips on track 1 (got ' + clips.length + ')');
  const c1 = clips[0].id, c2Start = clips[1].start, origSource = clips[0].sourceId, c1Dur = clips[0].duration;
  // Kept here: once a result replaces it, the editor drops the original from
  // storage (nothing references it) and only undo would bring it back.
  const orig = JSON.stringify(await r.eval(`window.__load(${JSON.stringify(origSource)}).then(function (d) { return Array.from(d); })`));

  // 2. Send clip 1 to the reverser, take it, run it as WAV, send it back.
  await r.eval(`ASEditLink.send('audio-reverser', ${JSON.stringify(c1)})`);
  await r.waitFor('location.pathname === "/audio-reverser" && !!document.getElementById("projectBar")');
  ok(await r.eval('!!document.querySelector("#projectBar canvas")'), 'the project bar draws the clip\'s waveform');
  await r.eval('document.getElementById("outFmt").value = "wav"; document.querySelector(\'#projectBar [data-act="use"]\').click()');
  await r.waitFor('!document.getElementById("convertBtn").disabled');
  await r.eval('document.getElementById("convertBtn").click()');
  await r.waitFor('!!document.querySelector("#nextSteps .project-return a")');
  await r.eval('document.querySelector("#nextSteps .project-return a").click()');

  // 3. Back in the editor, restored and applied without a click.
  await r.waitFor('location.pathname === "/audio-editor" && /result applied/.test(document.getElementById("status").textContent)', 20000);
  await r.waitSaved();
  p = await r.project();
  let f = find(p, c1);
  ok(f && p.sources[f.sourceId].kind === 'derived', 'the clip now points at a derived source');
  ok(f && Math.abs(f.duration - c1Dur) < 1e-3, 'a same-length result keeps the clip length (' + (f && f.duration) + ' vs ' + c1Dur + ')');
  ok(Math.abs(p.tracks[0].clips[1].start - c2Start) < 1e-6, 'the next clip has not moved');
  const corr = await r.eval(`(${inPage.reversedCorrelation})(${orig}, ${JSON.stringify(f && f.sourceId)})`);
  ok(corr > 0.99, 'the returned audio is the reversed original (correlation ' + corr.toFixed(4) + ')');
  notes.push('reverser round trip: correlation with the reversed original ' + corr.toFixed(4));
  ok(await r.eval('ASLink.peekReturn().then(function (x) { return !x; })'), 'the return record is consumed');
  ok(await r.eval(`ASLink.getTarget().then(function (t) { return !!t && t.ref.clipId === ${JSON.stringify(c1)} && t.id === (ASLink.flag() || {}).target && t.fp.indexOf(${JSON.stringify(f && f.sourceId)}) > 0; })`),
    'the returned clip becomes what tool pages offer next, so the project keeps following you');

  // 4. Undo.
  await r.eval('document.getElementById("edUndo").click()');
  await r.waitSaved();
  p = await r.project();
  ok(find(p, c1) && find(p, c1).sourceId === origSource, 'one undo brings the original audio back');

  // 5. A length-changing tool ripples the next clip.
  await r.eval(`ASEditLink.send('audio-speed', ${JSON.stringify(c1)})`);
  await r.waitFor('location.pathname === "/audio-speed" && !!document.getElementById("projectBar")');
  await r.eval('document.getElementById("speed").value = "2"; document.getElementById("mode").value = "pitch-shift"; document.getElementById("outFmt").value = "wav"; document.querySelector(\'#projectBar [data-act="use"]\').click()');
  await r.waitFor('!document.getElementById("convertBtn").disabled');
  await r.eval('document.getElementById("convertBtn").click()');
  await r.waitFor('!!document.querySelector("#nextSteps .project-return a")', 20000);
  await r.eval('document.querySelector("#nextSteps .project-return a").click()');
  await r.waitFor('location.pathname === "/audio-editor" && /result applied/.test(document.getElementById("status").textContent)', 20000);
  await r.waitSaved();
  p = await r.project();
  f = find(p, c1);
  ok(f && Math.abs(f.duration - c1Dur / 2) < 0.02, 'at 2x the clip is half as long (' + (f && f.duration.toFixed(3)) + ' s)');
  ok(Math.abs(p.tracks[0].clips[1].start - (c2Start - c1Dur / 2)) < 0.02, 'and the next clip rippled in behind it (' + p.tracks[0].clips[1].start.toFixed(3) + ' s)');
  await r.eval('document.getElementById("edUndo").click()');
  await r.waitSaved();

  // 6. A same-length tool writing MP3: encoder delay is found and trimmed.
  await r.eval(`ASEditLink.send('noise-reduction', ${JSON.stringify(c1)})`);
  await r.waitFor('location.pathname === "/noise-reduction" && !!document.getElementById("projectBar")');
  await r.eval('document.getElementById("strength").value = "gentle"; document.querySelector(\'#projectBar [data-act="use"]\').click()');
  await r.waitFor('!document.getElementById("convertBtn").disabled');
  await r.eval('document.getElementById("convertBtn").click()');
  await r.waitFor('!!document.querySelector("#nextSteps .project-return a")', 60000);
  await r.eval('document.querySelector("#nextSteps .project-return a").click()');
  await r.waitFor('location.pathname === "/audio-editor" && /result applied/.test(document.getElementById("status").textContent)', 20000);
  const msg = await r.eval('document.getElementById("status").textContent');
  ok(/Lined up \d+ ms/.test(msg), 'an MP3 result has its encoder delay measured and trimmed (status: ' + msg + ')');
  await r.waitSaved();
  p = await r.project();
  f = find(p, c1);
  ok(f && Math.abs(f.duration - c1Dur) < 1e-3, 'and keeps the exact clip length');
  const lag0 = await r.eval(`(${inPage.zeroLagCorrelation})(${orig}, ${JSON.stringify(f && f.sourceId)})`);
  ok(lag0 > 0.9, 'the aligned MP3 result lines up with the original at zero lag (correlation ' + lag0.toFixed(3) + ')');
  notes.push('noise-reduction MP3 round trip: ' + (msg.match(/Lined up \d+ ms/) || ['no shift'])[0] + ', zero-lag correlation ' + lag0.toFixed(3));
  await r.eval('document.getElementById("edUndo").click()');
  await r.waitSaved();

  // 6b. Stems come back as a zip: the first file replaces the clip, the rest
  // land on new tracks below it at the same time. The zip is written by hand
  // here rather than by running the 64 MB separation model.
  const tracksBefore = p.tracks.length;
  await r.eval(`ASEditLink.send('stem-splitter', ${JSON.stringify(c1)})`);
  await r.waitFor('location.pathname === "/stem-splitter" && !!document.getElementById("projectBar")');
  await r.eval(`(${inPage.writeStemsReturn})()`);
  await r.waitFor('location.pathname === "/audio-editor" && /result applied/.test(document.getElementById("status").textContent)', 20000);
  await r.waitSaved();
  p = await r.project();
  f = find(p, c1);
  ok(p.tracks.length === tracksBefore + 1, 'a two-stem return adds exactly one track (' + tracksBefore + ' -> ' + p.tracks.length + ')');
  ok(f && /instrumental/.test(f.name), 'the clip is named for the stem that replaced it (' + (f && f.name) + ')');
  const stemTrack = p.tracks[1];
  ok(stemTrack && stemTrack.name === 'Acapella' && stemTrack.clips.length === 1 && Math.abs(stemTrack.clips[0].start - f.start) < 1e-6,
    'the other stem sits on a new track directly below, starting with the clip');
  await r.eval('document.getElementById("edUndo").click()');
  await r.waitSaved();
  p = await r.project();
  ok(p.tracks.length === tracksBefore, 'one undo takes the whole stems return off again');

  // 6c. A second editor tab does not save over the first: it says so, and
  // taking over moves the lock (the first tab stops saving).
  const second = await r.newTab('/audio-editor');
  await second.waitFor('!!document.querySelector(".ed-lockbar")');
  ok(await second.eval('document.getElementById("edSaved").dataset.state === "blocked"'), 'a second editor tab does not autosave');
  await second.eval('document.querySelector(".ed-lockbar button").click()');
  await second.waitFor('!document.querySelector(".ed-lockbar")');
  await r.waitFor('!!document.querySelector(".ed-lockbar")');
  ok(true, 'taking over moves the lock to the new tab');
  await second.eval('document.querySelector(".ed-lockbar") || 0');
  await second.close();
  await r.eval('document.querySelector(".ed-lockbar button").click()');
  await r.waitFor('!document.querySelector(".ed-lockbar")');
  await r.waitSaved();

  // 6d. A range on one track goes out dry and comes back into that range only:
  // the chirp is split around it and the reversed middle sits between.
  p = await r.project();
  const t1 = p.tracks[0].id, nTracks = p.tracks.length;
  await r.eval(`ASEditLink.send('audio-reverser', { kind: 'range', t0: 0.5, t1: 1.5, trackIds: [${JSON.stringify(t1)}], bounce: false, label: 'test range' })`);
  await r.waitFor('location.pathname === "/audio-reverser" && !!document.getElementById("projectBar")');
  ok(/test range/i.test(await r.eval('document.querySelector(".project-bar-meta").textContent')), 'the bar names the range it was sent');
  await r.eval('document.getElementById("outFmt").value = "wav"; document.querySelector(\'#projectBar [data-act="use"]\').click()');
  await r.waitFor('!document.getElementById("convertBtn").disabled');
  await r.eval('document.getElementById("convertBtn").click()');
  await r.waitFor('!!document.querySelector("#nextSteps .project-return a")');
  await r.eval('document.querySelector("#nextSteps .project-return a").click()');
  await r.waitFor('location.pathname === "/audio-editor" && /result applied/.test(document.getElementById("status").textContent)', 20000);
  await r.waitSaved();
  p = await r.project();
  let cs = p.tracks[0].clips.map((c) => [c.start, c.duration, p.sources[c.sourceId].kind]);
  ok(cs.length === 4 && Math.abs(cs[1][0] - 0.5) < 1e-3 && Math.abs(cs[1][1] - 1) < 2e-3 && cs[1][2] === 'derived' &&
    Math.abs(cs[2][0] - 1.5) < 1e-3 && Math.abs(cs[3][0] - c2Start) < 1e-6,
    'a one-track range comes back into exactly that range (' + JSON.stringify(cs.map((x) => [+x[0].toFixed(3), +x[1].toFixed(3), x[2]])) + ')');
  const rc = await r.eval(`(${inPage.rangeReversedCorrelation})(${orig}, ${JSON.stringify(p.tracks[0].clips[1].sourceId)}, 0.5, 1.5)`);
  ok(rc > 0.99, 'and it is the reversed middle of the chirp (correlation ' + rc.toFixed(4) + ')');
  notes.push('one-track range round trip: correlation with the reversed range ' + rc.toFixed(4));
  await r.eval('document.getElementById("edUndo").click()');
  await r.waitSaved();

  // 6e. The whole mix is bounced wet onto one new track, and cleared on the originals.
  const dur = c2Start + 1;
  await r.eval(`ASEditLink.send('audio-reverser', { kind: 'range', t0: 0, t1: ${dur}, trackIds: [${JSON.stringify(t1)}], bounce: true, label: 'The whole mix' })`);
  await r.waitFor('location.pathname === "/audio-reverser" && !!document.getElementById("projectBar")');
  await r.eval('document.getElementById("outFmt").value = "wav"; document.querySelector(\'#projectBar [data-act="use"]\').click()');
  await r.waitFor('!document.getElementById("convertBtn").disabled');
  await r.eval('document.getElementById("convertBtn").click()');
  await r.waitFor('!!document.querySelector("#nextSteps .project-return a")');
  await r.eval('document.querySelector("#nextSteps .project-return a").click()');
  await r.waitFor('location.pathname === "/audio-editor" && /result applied/.test(document.getElementById("status").textContent)', 20000);
  await r.waitSaved();
  p = await r.project();
  const bounce = p.tracks[0];
  ok(p.tracks.length === nTracks + 1 && /bounce/.test(bounce.name) && bounce.clips.length === 1 && Math.abs(bounce.clips[0].duration - dur) < 2e-3,
    'a mix comes back as one bounce track (' + p.tracks.map((t) => t.name + ':' + t.clips.length).join(', ') + ')');
  ok(p.tracks[1].clips.length === 0, 'and the original track is cleared in that range');
  await r.eval('document.getElementById("edUndo").click()');
  await r.waitSaved();
  p = await r.project();
  ok(p.tracks.length === nTracks && p.tracks[0].clips.length === 2, 'one undo restores the tracks the bounce replaced');

  // 7. Edit the clip while the tool is open: the editor must ask.
  await r.eval(`ASEditLink.send('audio-reverser', ${JSON.stringify(c1)})`);
  await r.waitFor('location.pathname === "/audio-reverser" && !!document.getElementById("projectBar")');
  await r.eval(`(${inPage.trimStoredClip})(${JSON.stringify(c1)})`);
  await r.eval('document.getElementById("outFmt").value = "wav"; document.querySelector(\'#projectBar [data-act="use"]\').click()');
  await r.waitFor('!document.getElementById("convertBtn").disabled');
  await r.eval('document.getElementById("convertBtn").click()');
  await r.waitFor('!!document.querySelector("#nextSteps .project-return a")');
  await r.eval('document.querySelector("#nextSteps .project-return a").click()');
  await r.waitFor('location.pathname === "/audio-editor" && !document.getElementById("edSheet").hidden', 20000);
  ok(await r.eval('!!document.querySelector(\'#edSheet [data-v="replace"]\') && !!document.querySelector(\'#edSheet [data-v="track"]\')'),
    'a clip edited since it was sent gets a choice, not a silent replace');
}

function find(p, id) {
  for (const t of p.tracks) for (const c of t.clips) if (c.id === id) return c;
  return null;
}

/* ------------------------------------------------------ runs in the page */

const inPage = {
  makeFiles: function () {
    var sr = 44100;
    function wav(len, fill) {
      var b = new AudioBuffer({ numberOfChannels: 2, length: len, sampleRate: sr });
      var l = b.getChannelData(0), r = b.getChannelData(1);
      for (var i = 0; i < len; i++) { var v = fill(i / sr); l[i] = v; r[i] = v * 0.8; }
      return AudioSaw.audioBufferToWav(b);
    }
    // A chirp with a slow tremolo: asymmetric in time, so its reverse is
    // unmistakable, and broadband enough to correlate sharply.
    var a = wav(sr * 2, function (t) { return 0.5 * Math.sin(2 * Math.PI * (200 * t + 450 * t * t)) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 1.3 * t)); });
    var b = wav(sr, function (t) { return 0.3 * Math.sin(2 * Math.PI * 440 * t); });
    var dt = new DataTransfer();
    dt.items.add(new File([a], 'chirp.wav', { type: 'audio/wav' }));
    dt.items.add(new File([b], 'tone.wav', { type: 'audio/wav' }));
    var input = document.getElementById('fileInput');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  },

  readProject: function () {
    return new Promise(function (res, rej) {
      var r = indexedDB.open('audiosaw-editor', 1);
      r.onerror = function () { rej(r.error); };
      r.onsuccess = function () {
        var g = r.result.transaction('meta').objectStore('meta').get('project');
        g.onsuccess = function () { r.result.close(); res(g.result); };
      };
    });
  },

  // Decode what the editor stored for a source: the original file, or the
  // Float32 samples of a derived one.
  loadSource: function (id) {
    return new Promise(function (res, rej) {
      var r = indexedDB.open('audiosaw-editor', 1);
      r.onerror = function () { rej(r.error); };
      r.onsuccess = function () {
        var g = r.result.transaction('sources').objectStore('sources').get(id);
        g.onsuccess = function () {
          r.result.close();
          var rec = g.result;
          if (!rec) return rej(new Error('source ' + id + ' not stored'));
          if (rec.file) return AudioSaw.decodeToAudioBuffer(rec.file).then(function (b) { res(b.getChannelData(0)); }, rej);
          res(rec.chans[0]);
        };
      };
    });
  },

  reversedCorrelation: async function (a, outId) {
    var b = await window.__load(outId);
    var n = Math.min(a.length, b.length), s = 0, ea = 0, eb = 0;
    for (var i = 0; i < n; i++) { var x = a[a.length - 1 - i], y = b[i]; s += x * y; ea += x * x; eb += y * y; }
    return s / Math.sqrt(ea * eb);
  },

  rangeReversedCorrelation: async function (a, outId, t0, t1) {
    var b = await window.__load(outId);
    var i0 = Math.round(t0 * b.length / (t1 - t0)), n = b.length, s = 0, ea = 0, eb = 0;
    // Stereo render of a stereo clip at centre is unity on the left channel.
    for (var i = 0; i < n; i++) { var x = a[i0 + n - 1 - i], y = b[i]; s += x * y; ea += x * x; eb += y * y; }
    return s / Math.sqrt(ea * eb);
  },

  zeroLagCorrelation: async function (a, outId) {
    var b = await window.__load(outId);
    // Skip the first and last 50 ms: the denoiser's STFT edges are not what is measured.
    var skip = 2400, n = Math.min(a.length, b.length) - skip, s = 0, ea = 0, eb = 0;
    for (var i = skip; i < n; i++) { s += a[i] * b[i]; ea += a[i] * a[i]; eb += b[i] * b[i]; }
    return s / Math.sqrt(ea * eb);
  },

  writeStemsReturn: async function () {
    var t = await ASLink.getTarget();
    var zip = await AudioSaw.zipBlobs([
      { name: 'chirp-instrumental.wav', blob: t.blob },
      { name: 'chirp-acapella.wav', blob: t.blob }
    ]);
    await ASLink.putReturn({ v: 1, id: 'rtest', targetId: t.id, projectId: t.projectId, tool: 'stem-splitter', name: 'chirp-separated.zip', blob: zip, createdAt: Date.now() });
    location.href = '/audio-editor?return=rtest';
  },

  // Simulate an edit made in another tab while the tool page was open.
  trimStoredClip: function (clipId) {
    return new Promise(function (res, rej) {
      var r = indexedDB.open('audiosaw-editor', 1);
      r.onerror = function () { rej(r.error); };
      r.onsuccess = function () {
        var tx = r.result.transaction('meta', 'readwrite'), st = tx.objectStore('meta');
        var g = st.get('project');
        g.onsuccess = function () {
          var p = JSON.parse(g.result);
          p.tracks.forEach(function (t) { t.clips.forEach(function (c) { if (c.id === clipId) c.duration -= 0.5; }); });
          st.put(JSON.stringify(p), 'project');
        };
        tx.oncomplete = function () { r.result.close(); res(); };
      };
    });
  }
};

/* ------------------------------------------------------------- plumbing */

function makeRunner(cdp, origin) {
  async function evaluate(expr) {
    const res = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, timeout: 120000 });
    if (res.result && res.result.exceptionDetails) {
      const d = res.result.exceptionDetails;
      throw new Error('in page: ' + ((d.exception && d.exception.description) || d.text));
    }
    return res.result && res.result.result ? res.result.result.value : undefined;
  }
  async function waitFor(expr, ms) {
    const until = Date.now() + (ms || 15000);
    let last = null;
    while (Date.now() < until) {
      try { if (await evaluate('!!(' + expr + ')')) return; } catch (e) { last = e; }
      await sleep(100);
    }
    const status = await evaluate('(document.getElementById("status") || {}).textContent || ""').catch(() => '');
    throw new Error('timed out waiting for: ' + expr + (status ? '\n  page status: ' + status : '') + (last ? '\n  ' + last.message : ''));
  }
  const helpers = `window.__load = ${inPage.loadSource}; window.__project = ${inPage.readProject};`;
  return {
    eval: async (e) => { await evaluate(helpers); return evaluate(e); },
    waitFor,
    open: async (p) => { await cdp.send('Page.navigate', { url: origin + p }); await sleep(300); },
    waitSaved: async () => {
      await sleep(200);
      await waitFor('document.getElementById("edSaved").dataset.state === "saved"', 15000);
    },
    project: async () => JSON.parse(await evaluate(`(${inPage.readProject})()`)),
    newTab: async (p) => {
      const t = await cdp.send('Target.createTarget', { url: origin + p });
      const targetId = t.result.targetId;
      const other = await attach(cdp.port, targetId);
      const r2 = makeRunner(other, origin);
      r2.close = async () => { other.close(); await cdp.send('Target.closeTarget', { targetId }); };
      return r2;
    }
  };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function connect(dir) {
  const f = path.join(dir, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !fs.existsSync(f); i++) await sleep(100);
  const port = fs.readFileSync(f, 'utf8').split('\n')[0];
  return attach(port, null);
}

async function attach(port, targetId) {
  const pick = (list) => list.find((t) => t.type === 'page' && (!targetId || t.id === targetId));
  let list = [];
  for (let i = 0; i < 50 && !pick(list); i++) {
    list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
    if (!pick(list)) await sleep(100);
  }
  const ws = new WebSocket(pick(list).webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
  return {
    send: (method, params) => new Promise((r) => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); }),
    close: () => ws.close(),
    port
  };
}
