/*
 * /metronome. Clicks are scheduled on the AudioContext clock, ~120 ms ahead,
 * by a timer that only decides *what* to schedule, never *when* it sounds.
 * A setInterval that played each click itself would drift and stutter
 * whenever the page was busy; this way the timer can be late by a whole
 * frame and every click still lands on its sample.
 *
 * The speed trainer raises the tempo by a step every N bars up to a ceiling,
 * which is how the usual advice for learning a hard passage ("start slow,
 * add a few BPM when it is clean") gets done without stopping to retype.
 */
(function (global) {
  'use strict';
  var CV = global.CV;
  if (!CV) { console.error('metronome-page: CV missing — /js includes must come first'); return; }
  var $ = CV.$;

  var el = {
    bpm: $('#mBpm'), bpmRange: $('#mBpmRange'), bpmOut: $('#mBpmOut'), sig: $('#mSig'), sub: $('#mSub'),
    sound: $('#mSound'), vol: $('#mVol'), accent: $('#mAccent'), start: $('#mStart'), tap: $('#mTap'),
    dots: $('#mDots'), trainer: $('#mTrainer'), step: $('#mStep'), every: $('#mEvery'), ceil: $('#mCeil'),
    trainNote: $('#mTrainNote'), status: $('#status')
  };

  var ctx = null, gain = null, bufs = null, timer = 0, running = false;
  var nextT = 0, beatIdx = 0, subIdx = 0, barCount = 0, bpm = 100, log = [];
  var LOOK = 0.12, TICK = 25;

  function num(v, lo, hi, d) { v = parseFloat(v); return isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d; }
  function sig() { var s = el.sig.value.split('/').map(Number); return { n: s[0], d: s[1] }; }

  // Three voices per sound: downbeat, beat, subdivision.
  var SOUNDS = {
    click: [[2000, 0.008], [1000, 0.008], [1000, 0.004]],
    wood: [[1250, 0.02], [880, 0.02], [880, 0.01]],
    beep: [[1760, 0.06], [880, 0.06], [880, 0.03]]
  };
  function makeBufs() {
    var sr = ctx.sampleRate, out = {};
    Object.keys(SOUNDS).forEach(function (k) {
      out[k] = SOUNDS[k].map(function (v, i) {
        var n = Math.round(sr * (v[1] * 6 + 0.01)), b = ctx.createBuffer(1, n, sr), d = b.getChannelData(0);
        var amp = i === 2 ? 0.45 : 0.85;
        for (var j = 0; j < n; j++) {
          var t = j / sr, env = Math.exp(-t / v[1]) * Math.min(1, t / 0.0005);
          // The woodblock gets a second, inharmonic partial; the others are pure.
          var s = Math.sin(2 * Math.PI * v[0] * t) + (k === 'wood' ? 0.5 * Math.sin(2 * Math.PI * v[0] * 2.76 * t) : 0);
          d[j] = amp * env * s * (k === 'wood' ? 0.7 : 1);
        }
        return b;
      });
    });
    return out;
  }

  function perBeat() { return { none: 1, eighth: 2, triplet: 3, sixteenth: 4 }[el.sub.value] || 1; }

  // A beat is the denominator's note, so 6/8 at 120 is six eighths a bar.
  function beatSec() { return 60 / bpm * 4 / sig().d; }

  function schedule() {
    var s = sig(), per = perBeat();
    // A hidden tab's timers can be held to once a second, so look further
    // ahead then; tempo changes take a little longer to land, the click never
    // gaps.
    var look = document.hidden ? 1.5 : LOOK;
    while (nextT < ctx.currentTime + look) {
      // In compound metres (6/8, 9/8, 12/8) only the start of each group of
      // three gets the beat voice, so 6/8 is felt in two, not six.
      var compound = s.d === 8 && s.n > 3 && s.n % 3 === 0;
      var voice = subIdx > 0 || (compound && beatIdx % 3 !== 0) ? 2 : (beatIdx === 0 && el.accent.checked ? 0 : 1);
      var src = ctx.createBufferSource();
      src.buffer = bufs[el.sound.value][voice];
      src.connect(gain);
      src.start(nextT);
      log.push(nextT); if (log.length > 64) log.shift();
      if (subIdx === 0) flash(beatIdx, nextT);
      nextT += beatSec() / per;
      subIdx++;
      if (subIdx >= per) {
        subIdx = 0;
        beatIdx++;
        if (beatIdx >= s.n) { beatIdx = 0; barCount++; train(); }
      }
    }
  }

  function train() {
    if (!el.trainer.checked) return;
    var every = num(el.every.value, 1, 64, 4), step = num(el.step.value, 1, 40, 5), top = num(el.ceil.value, 30, 300, 160);
    if (barCount % every !== 0 || bpm >= top) return;
    setBpm(Math.min(top, bpm + step), true);
  }

  // The dots follow what is heard, so each flash is delayed to its click's
  // context time rather than drawn when it was scheduled.
  function flash(i, when) {
    var delay = Math.max(0, (when - ctx.currentTime) * 1000);
    setTimeout(function () {
      if (!running) return;
      Array.prototype.forEach.call(el.dots.children, function (d, k) { d.classList.toggle('on', k === i); });
    }, delay);
  }

  function drawDots() {
    var s = sig(), html = '';
    for (var i = 0; i < s.n; i++) html += '<span class="m-dot' + (i === 0 && el.accent.checked ? ' m-dot-one' : '') + '"></span>';
    el.dots.innerHTML = html;
  }

  function setBpm(v, fromTrainer) {
    bpm = Math.round(num(v, 30, 300, 100) * 10) / 10;
    el.bpm.value = bpm; el.bpmRange.value = bpm; el.bpmOut.textContent = bpm;
    if (fromTrainer) el.trainNote.textContent = 'Now ' + bpm + ' BPM.';
    try { localStorage.setItem('as_metro_bpm', String(bpm)); } catch (e) {}
  }

  function start() {
    if (!ctx) {
      var C = global.AudioContext || global.webkitAudioContext;
      ctx = new C({ latencyHint: 'interactive' });
      gain = ctx.createGain(); gain.connect(ctx.destination);
      bufs = makeBufs();
    }
    ctx.resume();
    gain.gain.value = num(el.vol.value, 0, 1, 0.8);
    running = true;
    beatIdx = 0; subIdx = 0; barCount = 0; log = [];
    nextT = ctx.currentTime + 0.08;
    schedule();
    timer = setInterval(schedule, TICK);
    el.start.textContent = 'Stop';
    el.start.classList.add('is-on');
    el.trainNote.textContent = el.trainer.checked ? 'Speed trainer on: +' + num(el.step.value, 1, 40, 5) + ' BPM every ' + num(el.every.value, 1, 64, 4) + ' bars, up to ' + num(el.ceil.value, 30, 300, 160) + '.' : '';
  }

  function stop() {
    running = false;
    clearInterval(timer);
    if (ctx) ctx.suspend();
    el.start.textContent = 'Start';
    el.start.classList.remove('is-on');
    Array.prototype.forEach.call(el.dots.children, function (d) { d.classList.remove('on'); });
  }

  el.start.addEventListener('click', function () { if (running) stop(); else start(); });
  el.bpm.addEventListener('change', function () { setBpm(el.bpm.value); });
  el.bpmRange.addEventListener('input', function () { setBpm(el.bpmRange.value); });
  Array.prototype.forEach.call(document.querySelectorAll('[data-nudge]'), function (b) {
    b.addEventListener('click', function () { setBpm(bpm + parseFloat(b.getAttribute('data-nudge'))); });
  });
  el.sig.addEventListener('change', function () { drawDots(); beatIdx = 0; subIdx = 0; });
  el.accent.addEventListener('change', drawDots);
  el.vol.addEventListener('input', function () { if (gain) gain.gain.value = num(el.vol.value, 0, 1, 0.8); });

  // Tap tempo: the median of the last few intervals, reset after a 2 s gap.
  var taps = [];
  el.tap.addEventListener('click', function () {
    var now = performance.now();
    if (taps.length && now - taps[taps.length - 1] > 2000) taps = [];
    taps.push(now);
    if (taps.length > 8) taps.shift();
    if (taps.length >= 3) {
      var iv = [];
      for (var i = 1; i < taps.length; i++) iv.push(taps[i] - taps[i - 1]);
      iv.sort(function (a, b) { return a - b; });
      setBpm(60000 / iv[Math.floor(iv.length / 2)]);
    }
  });

  document.addEventListener('keydown', function (e) {
    var tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
    if (e.key === ' ') { e.preventDefault(); if (running) stop(); else start(); }
    else if (e.key === 't' || e.key === 'T') el.tap.click();
    else if (e.key === 'ArrowUp') { e.preventDefault(); setBpm(bpm + 1); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setBpm(bpm - 1); }
  });

  try { var saved = parseFloat(localStorage.getItem('as_metro_bpm')); if (saved) setBpm(saved); else setBpm(100); } catch (e) { setBpm(100); }
  var q = location.search.match(/[?&]bpm=([0-9.]+)/);
  if (q) setBpm(q[1]);
  drawDots();

  // For tools/check-metronome.js: the context times clicks were scheduled at.
  global.ASMetronome = { log: function () { return log.slice(); }, isRunning: function () { return running; } };
})(window);
