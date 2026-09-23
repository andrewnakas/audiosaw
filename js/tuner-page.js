/*
 * /tuner. The microphone is read on the audio thread's clock through an
 * AnalyserNode, and each window goes through the same YIN detector as
 * /audio-to-midi and /autotune (js/pitch-track.js), checked by
 * tools/check-pitch.js to within a cent from 31 Hz (a five-string bass's low B) to 1.3 kHz.
 *
 * The needle is the median of the last five readings. A raw reading jumps
 * by a few cents from window to window on a real string, and a needle that
 * twitches is harder to tune to than one that settles.
 *
 * Echo cancellation, noise suppression and automatic gain are all turned
 * off, as for recording in the editor: they are built for calls and they
 * bend the waveform a pitch detector is trying to read.
 */
(function (global) {
  'use strict';
  var CV = global.CV, P = global.ASPitch;
  if (!CV) { console.error('tuner-page: CV missing — /js includes must come first'); return; }
  var $ = CV.$;

  var el = {
    start: $('#tStart'), note: $('#tNote'), oct: $('#tOct'), cents: $('#tCents'), hz: $('#tHz'),
    needle: $('#tNeedle'), dial: $('#tDial'), ref: $('#tRef'), inst: $('#tInst'), strings: $('#tStrings'),
    status: $('#status')
  };

  // Standard tunings, low string first, as MIDI notes.
  var INSTRUMENTS = {
    chromatic: null,
    guitar: [40, 45, 50, 55, 59, 64],          // E2 A2 D3 G3 B3 E4
    dropd: [38, 45, 50, 55, 59, 64],           // D2 A2 D3 G3 B3 E4
    bass: [28, 33, 38, 43],                    // E1 A1 D2 G2
    bass5: [23, 28, 33, 38, 43],               // B0 E1 A1 D2 G2
    ukulele: [67, 60, 64, 69],                 // G4 C4 E4 A4 (re-entrant)
    violin: [55, 62, 69, 76],                  // G3 D4 A4 E5
    viola: [48, 55, 62, 69],                   // C3 G3 D4 A4
    cello: [36, 43, 50, 57]                    // C2 G2 D3 A3
  };
  var NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

  var ctx = null, stream = null, analyser = null, buf = null, timer = 0, hist = [], quiet = 0;

  function refHz() { var v = parseFloat(el.ref.value); return v >= 400 && v <= 480 ? v : 440; }
  function midiOf(hz) { return 69 + 12 * Math.log(hz / refHz()) / Math.LN2; }
  function hzOf(m) { return refHz() * Math.pow(2, (m - 69) / 12); }

  function drawStrings(active) {
    var set = INSTRUMENTS[el.inst.value];
    if (!set) { el.strings.innerHTML = ''; return; }
    el.strings.innerHTML = set.map(function (m) {
      return '<span class="t-string' + (m === active ? ' on' : '') + '">' + NAMES[m % 12] + (Math.floor(m / 12) - 1) + '</span>';
    }).join('');
  }

  function show(hz) {
    var m = midiOf(hz), set = INSTRUMENTS[el.inst.value], target;
    if (set) {
      // With an instrument chosen, tune toward the nearest open string, even
      // when it is more than a semitone away: a string that is far off is
      // exactly when you need to know which one it is.
      target = set.reduce(function (a, b) { return Math.abs(b - m) < Math.abs(a - m) ? b : a; });
    } else {
      target = Math.round(m);
    }
    var cents = Math.round((m - target) * 100), clamp = Math.max(-50, Math.min(50, cents));
    el.note.textContent = NAMES[((target % 12) + 12) % 12];
    el.oct.textContent = String(Math.floor(target / 12) - 1);
    el.cents.textContent = (cents > 0 ? '+' : '') + cents + ' cents';
    el.hz.textContent = hz.toFixed(1) + ' Hz · target ' + hzOf(target).toFixed(1) + ' Hz';
    el.needle.style.transform = 'rotate(' + (clamp * 0.9) + 'deg)';
    var inTune = Math.abs(cents) <= 3;
    el.dial.classList.toggle('in-tune', inTune);
    el.dial.classList.toggle('far', Math.abs(cents) > 50);
    el.cents.textContent += inTune ? ' · in tune' : cents < 0 ? ' · tune up' : ' · tune down';
    drawStrings(set ? target : null);
  }

  function idle() {
    el.dial.classList.remove('in-tune', 'far');
    el.cents.textContent = 'Play one note';
  }

  function tick() {
    analyser.getFloatTimeDomainData(buf);
    var rms = 0;
    for (var i = 0; i < buf.length; i++) rms += buf[i] * buf[i];
    rms = Math.sqrt(rms / buf.length);
    if (rms < 0.004) { if (++quiet > 8) { hist = []; idle(); } return; }
    var set = INSTRUMENTS[el.inst.value];
    var lo = set ? Math.max(25, hzOf(set[0] - 5)) : 30, hi = set ? Math.min(2000, hzOf(set[set.length - 1] + 5)) : 1600;
    var r = P.yin(buf, ctx.sampleRate, { minHz: lo, maxHz: hi, threshold: 0.12 });
    if (!r.hz || r.clarity < 0.88) return;
    quiet = 0;
    hist.push(r.hz);
    if (hist.length > 5) hist.shift();
    var sorted = hist.slice().sort(function (a, b) { return a - b; });
    show(sorted[Math.floor(sorted.length / 2)]);
  }

  function start() {
    if (!navigator.mediaDevices || !global.isSecureContext) {
      CV.setStatus(el.status, 'error', 'The tuner needs microphone access, which needs a secure (https) page.');
      return;
    }
    var C = global.AudioContext || global.webkitAudioContext;
    ctx = ctx || new C({ latencyHint: 'interactive' });
    ctx.resume();
    navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } }).then(function (s) {
      stream = s;
      var src = ctx.createMediaStreamSource(s);
      analyser = ctx.createAnalyser();
      // 4096 samples is 85 ms at 48 kHz: two full periods of a low B on a
      // five-string bass, which YIN needs, and still quick enough to follow.
      analyser.fftSize = 4096;
      buf = new Float32Array(analyser.fftSize);
      src.connect(analyser);
      timer = setInterval(tick, 50);
      el.start.textContent = 'Stop';
      el.start.classList.add('is-on');
      CV.setStatus(el.status, 'info', 'Listening. Play one note at a time, and let it ring.');
      idle();
    }).catch(function (err) {
      CV.setStatus(el.status, 'error', err && err.name === 'NotAllowedError'
        ? 'Microphone permission was refused. Allow it in the address bar and try again.'
        : 'Could not open the microphone: ' + ((err && err.message) || 'none found') + '.');
    });
  }

  function stop() {
    clearInterval(timer); timer = 0;
    if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
    stream = null;
    el.start.textContent = 'Start tuning';
    el.start.classList.remove('is-on');
    CV.clearStatus(el.status);
    idle();
    el.cents.textContent = '';
  }

  el.start.addEventListener('click', function () { if (timer) stop(); else start(); });
  el.inst.addEventListener('change', function () {
    hist = [];
    drawStrings(null);
    try { localStorage.setItem('as_tuner_inst', el.inst.value); } catch (e) {}
  });
  el.ref.addEventListener('change', function () {
    try { localStorage.setItem('as_tuner_ref', String(refHz())); } catch (e) {}
  });
  try {
    var si = localStorage.getItem('as_tuner_inst'), sr = localStorage.getItem('as_tuner_ref');
    if (si && INSTRUMENTS.hasOwnProperty(si)) el.inst.value = si;
    if (sr) el.ref.value = sr;
  } catch (e) {}
  drawStrings(null);

})(window);
