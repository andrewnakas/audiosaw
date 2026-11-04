/*
 * /tone-generator page controller.
 *
 * Live: a steady tone is an OscillatorNode, so the frequency, level and
 * channel follow the controls without a gap (each change is a 15 ms glide,
 * never a jump, which would click). Sweeps and noises are rendered by
 * js/tone-gen.js and played as a buffer, a noise looped.
 *
 * Download: every file is rendered by tone-gen.js at the chosen rate,
 * whatever was playing, so a downloaded 1 kHz tone is exactly 1 kHz (the
 * check measures it) and a square is band-limited the same way it sounded.
 *
 * Playing for three seconds is this page's success (target_format 'play'),
 * once per visit, as hearing a result is on /text-to-speech.
 */
(function (global) {
  'use strict';
  var CV = global.CV, T = global.ASTone;
  if (!CV || !T) { console.error('tone-page: CV/ASTone missing — /js includes must come first'); return; }
  var $ = CV.$;

  var el = {
    play: $('#tgPlay'), freq: $('#tgFreq'), slider: $('#tgSlider'), note: $('#tgNote'), wave: $('#tgWave'),
    vol: $('#tgVol'), volOut: $('#tgVolOut'), chan: $('#tgChan'), beat: $('#tgBeat'),
    sweepOn: $('#tgSweep'), freq2: $('#tgFreq2'), sweepSec: $('#tgSweepSec'), sweepLin: $('#tgSweepLin'),
    secs: $('#tgSecs'), fmt: $('#tgFormat'), dl: $('#convertBtn'), status: $('#status'), presets: $('#tgPresets')
  };
  if (!el.play) return;

  var MIN = 1, MAX = 24000;
  var ctx = null, osc = null, osc2 = null, gain = null, panL = null, panR = null, merger = null, bufSrc = null;
  var playing = false, started = false, counted = false, playTimer = 0;

  function isNoise() { return /^(white|pink|brown)$/.test(el.wave.value); }
  function freq() { var f = parseFloat(el.freq.value); return isFinite(f) ? Math.max(MIN, Math.min(MAX, f)) : 440; }
  function amp() { return Math.pow(10, parseFloat(el.vol.value) / 20); }
  function beat() { var b = parseFloat(el.beat && el.beat.value); return isFinite(b) && b > 0 ? Math.min(b, 100) : 0; }
  function sweeping() { return el.sweepOn && el.sweepOn.checked && !isNoise(); }

  // The slider is logarithmic: 0..1000 spans 1 Hz to 24 kHz.
  function toSlider(f) { return Math.round(1000 * Math.log(f / MIN) / Math.log(MAX / MIN)); }
  function fromSlider(v) { return MIN * Math.pow(MAX / MIN, v / 1000); }

  function showNote() {
    var f = freq(), n = T.noteOf(f);
    el.note.textContent = f >= 16 && f <= 8000 ? n.name + (n.cents ? ' ' + (n.cents > 0 ? '+' : '') + n.cents + ' cents' : '') : '';
    el.volOut.textContent = el.vol.value + ' dBFS';
  }

  function ensureCtx() {
    var C = global.AudioContext || global.webkitAudioContext;
    if (!ctx) ctx = new C();
    ctx.resume();
    return ctx;
  }

  // Both oscillators (left, right) go through their own gain to a merger,
  // so the channel choice and a binaural offset are just gains and a
  // second frequency.
  function startOsc() {
    var c = ensureCtx(), now = c.currentTime;
    gain = c.createGain(); gain.gain.setValueAtTime(0, now);
    merger = c.createChannelMerger(2);
    panL = c.createGain(); panR = c.createGain();
    osc = c.createOscillator(); osc2 = c.createOscillator();
    osc.type = osc2.type = el.wave.value;
    osc.connect(panL).connect(merger, 0, 0);
    osc2.connect(panR).connect(merger, 0, 1);
    merger.connect(gain).connect(c.destination);
    apply(true);
    osc.start(); osc2.start();
  }

  function startBuffer() {
    var c = ensureCtx(), now = c.currentTime;
    var secs = sweeping() ? Math.max(1, Math.min(120, parseFloat(el.sweepSec.value) || 10)) : 10;
    var ch = T.render(opts(c.sampleRate, secs, 0.005));
    var b = c.createBuffer(2, ch[0].length, c.sampleRate);
    b.copyToChannel(ch[0], 0); b.copyToChannel(ch[1], 1);
    gain = c.createGain(); gain.gain.setValueAtTime(0, now); gain.gain.setTargetAtTime(1, now, 0.005);
    bufSrc = c.createBufferSource();
    bufSrc.buffer = b;
    bufSrc.loop = isNoise();
    bufSrc.connect(gain).connect(c.destination);
    bufSrc.onended = function () { if (playing && !bufSrc.loop) stop(); };
    bufSrc.start();
  }

  function opts(rate, seconds, fade) {
    return {
      wave: el.wave.value, freq: freq(), freq2: sweeping() ? Math.max(MIN, Math.min(MAX, parseFloat(el.freq2.value) || 20000)) : 0,
      sweep: el.sweepLin && el.sweepLin.checked ? 'lin' : 'log', seconds: seconds, rate: rate, amp: amp(),
      channel: el.chan.value, fade: fade, beat: beat()
    };
  }

  // Push the controls into the running oscillators with a short glide.
  function apply(first) {
    if (!osc || !ctx) return;
    var now = ctx.currentTime, k = first ? 0.005 : 0.015, f = freq(), ch = el.chan.value;
    osc.type = osc2.type = el.wave.value;
    osc.frequency.setTargetAtTime(f, now, first ? 0 : k);
    osc2.frequency.setTargetAtTime(f + beat(), now, first ? 0 : k);
    panL.gain.setTargetAtTime(ch === 'right' ? 0 : 1, now, k);
    panR.gain.setTargetAtTime(ch === 'left' ? 0 : 1, now, k);
    // The built-in waves are normalised to a peak of 1 (Web Audio's
    // PeriodicWave normalisation), so the gain is the asked peak.
    gain.gain.setTargetAtTime(amp(), now, k);
  }

  function play() {
    if (sweeping() || isNoise()) startBuffer(); else startOsc();
    playing = true;
    el.play.textContent = 'Stop';
    el.play.classList.add('is-on');
    if (!started) { started = true; CV.track('convert_start', { tool: 'tone-generator', target_format: 'play' }); }
    clearTimeout(playTimer);
    playTimer = setTimeout(function () {
      if (playing && !counted) { counted = true; CV.track('convert_success', { tool: 'tone-generator', target_format: 'play' }); }
    }, 3000);
  }

  function stop() {
    clearTimeout(playTimer);
    if (ctx && gain) {
      var now = ctx.currentTime, g = gain, o = osc, o2 = osc2, s = bufSrc;
      g.gain.cancelScheduledValues(now);
      g.gain.setValueAtTime(g.gain.value, now);
      g.gain.linearRampToValueAtTime(0, now + 0.02);
      setTimeout(function () {
        [o, o2, s].forEach(function (n) { if (n) try { n.stop(); n.disconnect(); } catch (e) {} });
        try { g.disconnect(); } catch (e) {}
      }, 60);
    }
    osc = osc2 = bufSrc = gain = null;
    playing = false;
    el.play.textContent = 'Play';
    el.play.classList.remove('is-on');
  }

  // A change that the oscillator cannot follow (to a noise, into a sweep)
  // restarts the sound; anything else glides.
  function changed() {
    showNote();
    if (!playing) return;
    if (osc && !sweeping() && !isNoise()) apply(false);
    else { stop(); play(); }
  }

  el.play.addEventListener('click', function () { if (playing) stop(); else play(); });
  el.freq.addEventListener('input', function () { el.slider.value = toSlider(freq()); changed(); });
  el.slider.addEventListener('input', function () {
    var f = fromSlider(+el.slider.value);
    el.freq.value = f < 100 ? f.toFixed(1) : String(Math.round(f));
    changed();
  });
  [el.wave, el.chan, el.sweepOn, el.sweepLin].forEach(function (x) { if (x) x.addEventListener('change', changed); });
  [el.vol, el.beat].forEach(function (x) { if (x) x.addEventListener('input', changed); });
  [el.freq2, el.sweepSec].forEach(function (x) { if (x) x.addEventListener('change', changed); });

  document.querySelectorAll('[data-step]').forEach(function (b) {
    b.addEventListener('click', function () {
      var f = freq() * Math.pow(2, parseFloat(b.getAttribute('data-step')) / 12);
      el.freq.value = f < 100 ? f.toFixed(2) : f.toFixed(1).replace(/\.0$/, '');
      el.slider.value = toSlider(freq());
      changed();
    });
  });
  if (el.presets) el.presets.addEventListener('click', function (e) {
    var b = e.target.closest('[data-hz]');
    if (!b) return;
    el.freq.value = b.getAttribute('data-hz');
    if (b.hasAttribute('data-wave')) el.wave.value = b.getAttribute('data-wave');
    el.slider.value = toSlider(freq());
    changed();
    if (!playing) play();
  });

  /* ------------------------------------------------------------ download */

  el.dl.addEventListener('click', async function () {
    var secs = Math.max(0.1, Math.min(600, parseFloat(el.secs.value) || 10));
    if (sweeping()) secs = Math.max(1, Math.min(600, parseFloat(el.sweepSec.value) || 10));
    var rate = 48000;
    el.dl.disabled = true;
    try {
      CV.setStatus(el.status, 'info', 'Rendering…');
      await new Promise(function (r) { setTimeout(r, 30); });
      var ch = T.render(opts(rate, secs, 0.005));
      var stereo = beat() || el.chan.value !== 'both';
      var buf = AudioSaw.makeBuffer(stereo ? ch : [ch[0]], rate);
      var fmt = el.fmt.value;
      var blob = await AudioSaw.encode(buf, fmt, {});
      var w = el.wave.value, name = isNoise() ? w + '-noise' : sweeping() ? w + '-sweep-' + Math.round(freq()) + '-' + Math.round(parseFloat(el.freq2.value)) + 'hz' : w + '-' + String(freq()).replace('.', '_') + 'hz';
      if (el.chan.value !== 'both') name += '-' + el.chan.value;
      CV.setStatus(el.status, 'success', 'Done: ' + secs + ' s, ' + rate / 1000 + ' kHz, ' + (stereo ? 'stereo' : 'mono') + ', peak ' + el.vol.value + ' dBFS.');
      CV.downloadBlob(blob, name + '-' + secs + 's.' + AudioSaw.extFor(fmt));
    } catch (e) {
      CV.setStatus(el.status, 'error', 'Could not write the file. ' + (e.message || e), e);
    }
    el.dl.disabled = false;
  });

  el.slider.value = toSlider(freq());
  showNote();
  global.__tone = { play: play, stop: stop, isPlaying: function () { return playing; } };
})(window);
