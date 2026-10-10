#!/usr/bin/env node
/*
 * Conversion errors: what they are filed under, and the failures behind them.
 *
 * convert_error's `error_type` is the only window GA4 has onto why a tool
 * failed, and for a long time most of it read `other`: a declined microphone,
 * a 0-byte download and a missing AudioWorklet all looked the same. Part 1
 * pins the classifier in flow.js against the messages the site really shows
 * (collected by driving the pages), including a DOMException's name when the
 * page passes the error itself, and the rule that a file's own name never
 * decides its bucket.
 *
 * Part 2 drives real pages in headless Chrome:
 *   - a 0-byte file is `empty_file`, not a decode failure;
 *   - a WMA (no browser decodes it) splits through decodeToAudioBuffer's
 *     ffmpeg fallback — needs local ffmpeg for the fixture and the cached core;
 *   - random bytes are `decode`, and a text file named .mp3 is turned down
 *     without fetching the 30 MB core;
 *   - the voice recorder's getUserMedia failures land in the mic_* buckets,
 *     and a MediaRecorder that throws is reported instead of hanging the page.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');
const { findChrome, withPage, ROOT } = require('./chrome-harness');

let fails = 0, passed = 0;
function check(ok, label) {
  if (ok) passed++;
  else { fails++; console.error('  FAIL ' + label); }
}

/* --------------------------------------------------- part 1: the buckets */

function loadFlow() {
  const doc = {
    readyState: 'complete',
    getElementById: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    dispatchEvent() {}
  };
  const win = {
    document: doc, location: { pathname: '/split-audio', search: '' }, addEventListener() {},
    URLSearchParams, WeakSet, console,
    CV: { downloadBlob() {}, setStatus() {}, setProgress() {}, bindDropzone(d, i, fn) { win.__deliver = fn; }, fmtBytes: String, isAudio: () => true }
  };
  win.window = win;
  vm.createContext(win);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/flow.js'), 'utf8'), win);
  const dz = { addEventListener() {} };
  // The page's own dropzone, through flow.js's wrapper, so it learns the names.
  win.CV.bindDropzone(dz, {}, () => {});
  return { classify: win.CV.flow.classify, pick: (names) => win.__deliver(names.map((n) => ({ name: n, size: 1 }))) };
}

const dom = (name, message) => ({ name, message });
const TABLE = [
  // [message shown, error object or null, bucket]
  ['Selection too short.', null, 'validation'],
  ['Wrong file type: .amr — this tool takes MP3, WAV.', null, 'wrong_type'],
  ['Could not split that file. That file is empty (0 bytes).', null, 'empty_file'],
  ['Microphone access was blocked. Allow it in your browser\'s address bar, then press record again.', dom('NotAllowedError', 'Permission denied'), 'mic_denied'],
  ['Microphone access was blocked. Allow it in your browser\'s address bar, then press record again.', null, 'mic_denied'],
  ['Could not open the microphone. Requested device not found', dom('NotFoundError', 'Requested device not found'), 'mic_missing'],
  ['Could not open the microphone. Could not start audio source', dom('NotReadableError', 'Could not start audio source'), 'mic_busy'],
  ['Could not open the microphone. OverconstrainedError', dom('OverconstrainedError', ''), 'mic_constraints'],
  ['Recording needs a secure (https) page and microphone support.', null, 'insecure'],
  ['Could not start studio recording in this browser. Cannot read properties of undefined (reading \'addModule\') Voice mode still works.', dom('TypeError', 'Cannot read properties of undefined (reading \'addModule\')'), 'unsupported_api'],
  ['This browser cannot record audio here (not supported in this browser: NotSupportedError).', dom('NotSupportedError', 'no audio types'), 'unsupported_api'],
  ['Separation failed. The separation worker could not start. Your browser may be blocking it.', null, 'unsupported_api'],
  ['Transcription failed. no available backend found. ERR: [wasm] RangeError: WebAssembly.Memory(): could not allocate memory', null, 'memory'],
  ['Transcription failed. no available backend found. ERR: [wasm] Error: previous call to \'initWasm()\' failed.', null, 'unsupported_api'],
  ['Could not hand it over: the browser has too little storage left for a 40 MB clip.', null, 'storage'],
  ['Export failed: The quota has been exceeded.', dom('QuotaExceededError', 'The quota has been exceeded.'), 'storage'],
  ['Could not process that file. memory access out of bounds', dom('RuntimeError', 'memory access out of bounds'), 'codec_crash'],
  ['Separation failed. That track is 75 minutes long. Both stems are held in memory at once, so past 10 minutes the tab runs out of room — split it into parts first.', null, 'too_long'],
  ['Could not split that file. Array buffer allocation failed', dom('RangeError', 'Array buffer allocation failed'), 'memory'],
  ['Could not decode: Could not decode this 70 MB file: decoded, it needs far more memory than the browser gave this page. Split it into shorter parts first.', null, 'memory'],
  ['Could not split that file. No gaps long enough were found. Try a shorter minimum gap, or split by duration instead.', null, 'no_content'],
  ['Nothing was recorded.', null, 'no_content'],
  ['Could not open song.mid: That is not a MIDI file..', null, 'bad_file'],
  ['Could not decode: Failed to load codec (Failed to fetch)', null, 'codec_load'],
  ['Separation failed. Could not download the model (HTTP 503)', null, 'codec_load'],
  ['Transcription failed. The model download kept failing. Check the connection and press Transcribe again — the parts that finished are saved, so it picks up from there.', null, 'codec_load'],
  ['Transcription failed. 21364832', null, 'codec_crash'],
  ['Voice cloning failed. Voice cloning needs WebGPU (current Chrome or Edge on a desktop or laptop). WebGPU is not supported in this browser.', null, 'unsupported_api'],
  ['Transcription failed. That file is over 120 minutes long (2:13:04). Past two hours the tab runs out of memory — split it into parts first.', null, 'too_long'],
  ['Could not split that file. Unable to decode audio data', dom('EncodingError', 'Unable to decode audio data'), 'decode'],
  ['All conversions failed: x.mp3 (Could not decode this file: ffmpeg found no audio it can read in it.)', null, 'decode'],
  ['Could not convert. The encoder could not write OGG with these settings', null, 'encode'],
  ['Cut failed: The user aborted a request.', dom('AbortError', 'The user aborted a request.'), 'aborted'],
  ['Export failed: x.foo is not a function', dom('TypeError', 'x.foo is not a function'), 'script_error']
];

function partOne() {
  const { classify, pick } = loadFlow();
  TABLE.forEach(([msg, err, want]) => {
    const got = classify(msg, err);
    check(got === want, `"${msg.slice(0, 70)}" -> ${got}, expected ${want}`);
  });
  // The file's own name must not decide the bucket: "silent" in a name read
  // as no_content, "empty" as empty, "too long" as a silent validation hint.
  pick(['silent-night.mp3', 'empty_room too long.wav']);
  const enc = 'All conversions failed: silent-night.mp3 (The encoder could not write MP3 with these settings)';
  check(classify(enc) === 'encode', 'a file name decided the bucket: ' + classify(enc));
  const ed = 'Could not open empty_room too long.wav: Failed to load codec (Failed to fetch).';
  check(classify(ed) === 'codec_load', 'a file name decided the bucket: ' + classify(ed));
  check(classify('Could not convert \u201cempty_room too long\u201d: Failed to fetch') === 'codec_load', 'a quoted clip name decided the bucket');
}

/* --------------------------------------------- part 2: the pages, live */

const CORE_FILE = path.join(os.homedir(), '.cache/audiosaw/ffmpeg-core-0.12.6.wasm');

function wmaFixture() {
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'as-err-'));
    const out = path.join(dir, 'voice-note.wma');
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=330:d=6',
      '-ac', '2', '-ar', '44100', '-c:a', 'wmav2', '-b:a', '64k', out], { stdio: 'ignore' });
    return fs.statSync(out).size > 1000 ? out : null;
  } catch (e) { return null; }
}

async function partTwo() {
  if (!findChrome()) { console.log('  (no Chrome: page checks skipped)'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'as-err-'));
  const empty = path.join(dir, 'empty_room.mp3'); fs.writeFileSync(empty, Buffer.alloc(0));
  const garbage = path.join(dir, 'zero-noise.mp3');
  const rnd = Buffer.alloc(3000); for (let i = 0; i < rnd.length; i++) rnd[i] = (i * 2654435761) >>> 24;
  fs.writeFileSync(garbage, rnd);
  const html = path.join(dir, 'download.mp3'); fs.writeFileSync(html, '<!DOCTYPE html><html><body>404 Not Found</body></html>\n');
  const wma = wmaFixture();
  const core = fs.existsSync(CORE_FILE) ? fs.readFileSync(CORE_FILE) : null;

  await withPage({ routes: core ? { '/__core.wasm': core } : {} }, async (page) => {
    let coreFetches = 0;
    page.listen('Fetch.requestPaused', (p) => {
      coreFetches++;
      if (core) page.send('Fetch.continueRequest', { requestId: p.requestId, url: page.url('/__core.wasm') });
      else page.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' });
    });
    await page.send('Fetch.enable', { patterns: [{ urlPattern: '*ffmpeg-core.wasm*' }] });
    await page.send('Network.enable');
    await page.send('Network.setBlockedURLs', { urls: ['*googletagmanager*', '*google-analytics*', '*fonts.googleapis*', '*fonts.gstatic*'] });

    async function open(p, preScript) {
      let id = null;
      if (preScript) id = (await page.send('Page.addScriptToEvaluateOnNewDocument', { source: preScript })).result.identifier;
      await page.goto(p, 800);
      for (let i = 0; i < 150; i++) {
        if (await page.eval("document.readyState === 'complete' && typeof CV === 'object'")) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      if (id) await page.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: id });
    }
    const events = () => page.eval(`(window.dataLayer || []).map((x) => Array.from(x)).filter((x) => x[0] === 'event' && /convert_(error|success)/.test(x[1])).map((x) => x[1] + (x[2] && x[2].error_type ? ':' + x[2].error_type : ''))`);

    async function split(file) {
      await open('/split-audio');
      await page.eval(`(() => { window.__out = null; const o = CV.downloadBlob; CV.downloadBlob = function (b, n) { window.__out = { n, size: b.size }; return o.apply(this, arguments); }; return 1; })()`);
      const doc = await page.send('DOM.getDocument', {});
      const q = await page.send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#fileInput' });
      await page.send('DOM.setFileInputFiles', { nodeId: q.result.nodeId, files: [file] });
      const r = await page.eval(`(async () => {
        const wait = async (fn, ms) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) return false; await new Promise((r) => setTimeout(r, 100)); } return true; };
        const btn = document.getElementById('convertBtn');
        await wait(() => !btn.disabled, 10000);
        btn.click();
        await wait(() => window.__out || document.querySelector('#status.error'), 120000);
        return { out: window.__out, status: document.getElementById('status').textContent };
      })()`, 180000);
      r.ev = await events();
      return r;
    }

    let r = await split(empty);
    check(r.ev.join() === 'convert_error:empty_file', '0-byte file: ' + r.ev.join() + ' / ' + r.status);
    r = await split(garbage);
    check(r.ev.join() === 'convert_error:decode', 'random bytes: ' + r.ev.join() + ' / ' + r.status);
    const before = coreFetches;
    r = await split(html);
    check(r.ev.join() === 'convert_error:decode', 'HTML named .mp3: ' + r.ev.join() + ' / ' + r.status);
    check(coreFetches === before, 'HTML named .mp3 fetched the ffmpeg core (' + (coreFetches - before) + ' requests)');
    if (wma && core) {
      r = await split(wma);
      check(r.out && /\.zip$/.test(r.out.n) && r.out.size > 10000, 'WMA through the ffmpeg fallback: ' + (r.out ? r.out.n + ' ' + r.out.size : 'no output') + ' / ' + r.status);
    } else console.log('  (no local ffmpeg or cached core: the WMA fallback check is skipped)');

    // The voice recorder, with getUserMedia refused in each of the ways it is.
    const MIC = [
      ['NotAllowedError', 'Permission denied', 'mic_denied'],
      ['NotFoundError', 'Requested device not found', 'mic_missing'],
      ['NotReadableError', 'Could not start audio source', 'mic_busy']
    ];
    for (const [name, msg, want] of MIC) {
      await open('/voice-recorder', `navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException(${JSON.stringify(msg)}, ${JSON.stringify(name)}));`);
      await page.eval(`(async () => { document.getElementById('recordBtn').click(); for (let i = 0; i < 50 && !document.querySelector('#status.error'); i++) await new Promise((r) => setTimeout(r, 100)); return 1; })()`);
      const ev = await events();
      check(ev.join() === 'convert_error:' + want, name + ': ' + ev.join());
    }
    page.logs.length = 0;
    await open('/voice-recorder', "window.MediaRecorder = class { constructor() { throw new DOMException('no audio types', 'NotSupportedError'); } static isTypeSupported() { return false; } };");
    await page.eval(`(async () => { document.getElementById('cleanup').value = 'clean'; document.getElementById('recordBtn').click(); for (let i = 0; i < 80 && !document.querySelector('#status.error'); i++) await new Promise((r) => setTimeout(r, 100)); return 1; })()`);
    const ev = await events();
    check(ev.join() === 'convert_error:unsupported_api', 'MediaRecorder that throws: ' + ev.join());
    check(!page.logs.some((l) => /exception/.test(l)), 'MediaRecorder that throws left an uncaught exception: ' + page.logs.join(' | ').slice(0, 300));
  });
}

(async () => {
  console.log('check-errors: error buckets and the failures behind them');
  partOne();
  await partTwo();
  console.log(`  ${passed} passed, ${fails} failed`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
