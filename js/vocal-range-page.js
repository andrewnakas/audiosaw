/*
 * /vocal-range-test. The microphone goes through an AnalyserNode (4096
 * samples, every 50 ms) into YIN (js/pitch-track.js, the tuner's detector),
 * and each reading into ASRange.Meter (js/vocal-range.js), which counts a
 * note only once it has been held for 300 ms. A recording can be analysed
 * instead, frame by frame, through the same meter.
 *
 * The AudioContext is made inside the click, before getUserMedia is awaited:
 * made after the permission prompt it can stay suspended (see /dictation).
 * Processing is asked off, as on the tuner: echo cancellation and noise
 * suppression bend the waveform a pitch detector reads.
 *
 * Analytics: convert_start on the first Start, and convert_success
 * (target_format 'range') once, when a range of at least a fifth is found.
 */
(function (global) {
  'use strict';
  var CV = global.CV, P = global.ASPitch, A = global.ASRange;
  if (!CV || !P || !A) { console.error('[vocal-range-test] the /js/* includes must come before vocal-range-page.js'); return; }
  var $ = CV.$;
  var el = {
    start: $('#rStart'), reset: $('#rReset'), note: $('#rNote'), cents: $('#rCents'), hint: $('#rHint'),
    low: $('#rLow'), high: $('#rHigh'), span: $('#rSpan'), type: $('#rType'), keys: $('#rKeys'), status: $('#status'),
    dropzone: $('#dropzone'), fileInput: $('#fileInput')
  };
  if (!el.start) return;
  var meter = new A.Meter(), ctx = null, stream = null, analyser = null, buf = null, timer = 0, started = false, counted = false;
  var KEY_LO = 36, KEY_HI = 96; // C2 to C7

  function drawKeys(current) {
    var c = el.keys; if (!c) return;
    var dpr = global.devicePixelRatio || 1, W = c.clientWidth || 600, H = c.clientHeight || 90;
    c.width = W * dpr; c.height = H * dpr;
    var g = c.getContext('2d'); g.scale(dpr, dpr);
    var css = getComputedStyle(document.body), ink = css.getPropertyValue('--ink').trim() || '#222', amber = css.getPropertyValue('--amber').trim() || '#c2410c', paper = css.getPropertyValue('--card').trim() || '#fff';
    var whites = []; for (var m = KEY_LO; m <= KEY_HI; m++) if ([1, 3, 6, 8, 10].indexOf(m % 12) < 0) whites.push(m);
    var kw = W / whites.length, r = meter.result();
    var inRange = function (k) { return r && k >= r.lo && k <= r.hi; };
    g.clearRect(0, 0, W, H);
    whites.forEach(function (k, i) {
      g.fillStyle = k === current ? amber : inRange(k) ? 'rgba(194,65,12,.28)' : paper;
      g.fillRect(i * kw, 0, kw, H - 14); g.strokeStyle = ink; g.lineWidth = 1; g.strokeRect(i * kw + 0.5, 0.5, kw - 1, H - 15);
      if (k % 12 === 0) { g.fillStyle = ink; g.font = '10px system-ui, sans-serif'; g.fillText('C' + (k / 12 - 1), i * kw + 2, H - 3); }
    });
    whites.forEach(function (k, i) {
      var b = k + 1;
      if (b > KEY_HI || [1, 3, 6, 8, 10].indexOf(b % 12) < 0) return;
      g.fillStyle = b === current ? amber : inRange(b) ? '#7a3a1a' : ink;
      g.fillRect((i + 1) * kw - kw * 0.3, 0, kw * 0.6, (H - 14) * 0.6);
    });
  }

  function showResult() {
    var r = meter.result();
    if (!r) { el.low.textContent = '–'; el.high.textContent = '–'; el.span.textContent = '–'; el.type.textContent = 'Sing a few notes to see it'; drawKeys(null); return; }
    el.low.textContent = r.loName + ' (' + r.loHz.toFixed(0) + ' Hz)';
    el.high.textContent = r.hiName + ' (' + r.hiHz.toFixed(0) + ' Hz)';
    el.span.textContent = r.semitones + ' semitones' + (r.octaves ? ' (' + r.octaves + ' octave' + (r.octaves > 1 ? 's' : '') + (r.extra ? ' and ' + r.extra : '') + ')' : '');
    el.type.textContent = r.semitones < 7 ? 'Keep going: sing lower and higher to see your voice type'
      : r.voice.type.name + (r.voice.runnerUp ? ', then ' + r.voice.runnerUp.name.toLowerCase() : '');
    if (r.semitones >= 7 && !counted) { counted = true; CV.track('convert_success', { tool: 'vocal-range-test', target_format: 'range' }); }
    drawKeys(meter.last ? meter.last.note : null);
  }

  function showLive() {
    var l = meter.last;
    if (!l) { el.note.textContent = '–'; el.cents.textContent = 'Sing one note and hold it'; return; }
    el.note.textContent = A.name(l.note);
    el.cents.textContent = (l.cents > 0 ? '+' : '') + l.cents + ' cents';
  }

  function tick() {
    analyser.getFloatTimeDomainData(buf);
    var rms = 0; for (var i = 0; i < buf.length; i++) rms += buf[i] * buf[i];
    rms = Math.sqrt(rms / buf.length);
    var r = rms < 0.004 ? { hz: 0, clarity: 0 } : P.yin(buf, ctx.sampleRate, { minHz: 60, maxHz: 1500, threshold: 0.12 });
    var before = meter.lo + ',' + meter.hi;
    meter.feed(r.hz, r.clarity, ctx.currentTime);
    showLive();
    if (meter.lo + ',' + meter.hi !== before) showResult(); else drawKeys(meter.last ? meter.last.note : null);
  }

  function start() {
    if (!navigator.mediaDevices || !global.isSecureContext) { CV.setStatus(el.status, 'error', 'The range test needs microphone access, which needs a secure (https) page.'); return; }
    var C = global.AudioContext || global.webkitAudioContext;
    ctx = ctx || new C({ latencyHint: 'interactive' });
    ctx.resume();
    if (!started) { started = true; CV.track('convert_start', { tool: 'vocal-range-test', target_format: 'range' }); }
    navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } }).then(function (s) {
      stream = s;
      var src = ctx.createMediaStreamSource(s);
      analyser = ctx.createAnalyser(); analyser.fftSize = 4096;
      buf = new Float32Array(analyser.fftSize);
      src.connect(analyser);
      timer = setInterval(tick, 50);
      el.start.textContent = 'Stop';
      el.start.classList.add('is-on');
      CV.setStatus(el.status, 'info', 'Listening. Sing down to your lowest comfortable note, then up to your highest, holding each for a moment.');
    }).catch(function (err) {
      CV.setStatus(el.status, 'error', err && err.name === 'NotAllowedError'
        ? 'Microphone permission was refused. Allow it in the address bar and try again.'
        : 'Could not open the microphone: ' + ((err && err.message) || 'none found') + '.', err);
    });
  }
  function stop() {
    clearInterval(timer); timer = 0;
    if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
    stream = null;
    el.start.textContent = meter.result() ? 'Keep going' : 'Start';
    el.start.classList.remove('is-on');
    CV.clearStatus(el.status);
  }
  el.start.addEventListener('click', function () { if (timer) stop(); else start(); });
  if (el.reset) el.reset.addEventListener('click', function () { meter.reset(); counted = false; showLive(); showResult(); });

  // A recording instead of the live microphone.
  if (el.dropzone && el.fileInput) {
    CV.bindDropzone(el.dropzone, el.fileInput, async function (files) {
      var f = files[0]; if (!f) return;
      if (!started) { started = true; CV.track('convert_start', { tool: 'vocal-range-test', target_format: 'range' }); }
      try {
        CV.setStatus(el.status, 'info', 'Reading ' + f.name + '…');
        var b = await global.AudioSaw.decodeToAudioBuffer(f);
        var n = b.length, mono = new Float32Array(n);
        for (var c = 0; c < b.numberOfChannels; c++) { var d = b.getChannelData(c); for (var i = 0; i < n; i++) mono[i] += d[i] / b.numberOfChannels; }
        CV.setStatus(el.status, 'info', 'Finding every held note…');
        await new Promise(function (r) { setTimeout(r, 0); });
        var frames = P.track(mono, b.sampleRate, { minHz: 60, maxHz: 1500, threshold: 0.12, winSec: 0.05, hopSec: 0.01 });
        meter = A.fromFrames(frames); counted = false;
        meter.last = null;
        showLive(); showResult();
        var r = meter.result();
        if (r) CV.setStatus(el.status, 'success', 'Range in ' + f.name + ': ' + r.loName + ' to ' + r.hiName + '.');
        else CV.setStatus(el.status, 'error', 'No held notes in ' + f.name + '. Sing single notes and hold each for half a second.');
      } catch (e) { CV.setStatus(el.status, 'error', 'Could not read that recording. ' + (e.message || e), e); }
    }, ['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.webm', '.aif', '.aiff', '.caf', '.mp4', '.mov']);
  }

  showLive(); showResult();
  global.addEventListener('resize', function () { drawKeys(meter.last ? meter.last.note : null); });
  global.__range = { state: function () { return { result: meter.result(), last: meter.last, low: el.low.textContent, high: el.high.textContent, type: el.type.textContent }; } };
})(window);
