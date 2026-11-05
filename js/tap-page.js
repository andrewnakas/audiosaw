/*
 * /tap-bpm page controller: js/tap-tempo.js behind a big pad.
 *
 * A tap is the pointerdown or keydown event's own timeStamp, not the time
 * the handler runs, so a busy page does not add jitter. Any key counts
 * except Tab, Escape (which resets) and the modifiers; a held key's repeats
 * do not. Optional: a song to tap along to, played by an <audio> element,
 * whose tempo js/bpm-detector.js measures for comparison.
 *
 * Analytics: convert_start on the first tap, convert_success (target_format
 * 'bpm') once, when the count is steady.
 */
(function (global) {
  'use strict';
  var CV = global.CV, T = global.ASTap;
  if (!CV || !T) { console.error('[tap-bpm] the /js/* includes must come before tap-page.js'); return; }
  var $ = CV.$;
  var el = {
    pad: $('#tapPad'), bpm: $('#tBpm'), pm: $('#tPm'), taps: $('#tTaps'), alt: $('#tAlt'), reset: $('#tReset'), metro: $('#tMetro'),
    dropzone: $('#dropzone'), fileInput: $('#fileInput'), player: $('#tPlayer'), file: $('#tFile'), status: $('#status')
  };
  if (!el.pad) return;
  var tapper = new T.Tapper(), started = false, counted = false, lastState = null;

  function show(s) {
    lastState = s;
    if (!s || !s.bpm) {
      el.bpm.textContent = s && s.taps === 1 ? 'Keep tapping' : 'Tap';
      el.pm.textContent = ''; el.taps.textContent = s && s.taps ? s.taps + ' tap' : '';
      el.alt.textContent = ''; el.metro.hidden = true;
      return;
    }
    var b = s.bpm;
    el.bpm.textContent = b.toFixed(1);
    el.pm.textContent = s.plusMinus != null && isFinite(s.plusMinus) ? '± ' + Math.max(0.1, s.plusMinus).toFixed(1) + ' BPM' : '';
    el.taps.textContent = s.taps + ' taps' + (s.ignored ? ', ' + s.ignored + ' off-beat ignored' : '') + (s.steady ? ' · steady' : '');
    el.alt.textContent = 'Half time ' + (b / 2).toFixed(1) + ' · double time ' + (b * 2).toFixed(1);
    el.metro.hidden = !s.steady;
    el.metro.href = '/metronome?bpm=' + Math.round(b * 10) / 10;
    if (s.steady && !counted) { counted = true; CV.track('convert_success', { tool: 'tap-bpm', target_format: 'bpm' }); }
  }
  function tap(t) {
    if (!started) { started = true; CV.track('convert_start', { tool: 'tap-bpm', target_format: 'bpm' }); }
    show(tapper.tap(t));
    el.pad.classList.remove('hit'); void el.pad.offsetWidth; el.pad.classList.add('hit');
  }
  function reset() { tapper.reset(); counted = false; show(null); }

  el.pad.addEventListener('pointerdown', function (e) { e.preventDefault(); tap(e.timeStamp); });
  el.pad.addEventListener('keydown', function (e) { if (e.key === ' ' || e.key === 'Enter') e.preventDefault(); });
  document.addEventListener('keydown', function (e) {
    if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
    var tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea' || tag === 'audio') return;
    if (e.key === 'Tab' || e.key === 'Shift') return;
    if (e.key === 'Escape') { reset(); return; }
    if (e.key === ' ') e.preventDefault();
    tap(e.timeStamp);
  });
  el.reset.addEventListener('click', reset);

  // A song to tap along to, and what it measures.
  if (el.dropzone && el.fileInput) {
    CV.bindDropzone(el.dropzone, el.fileInput, async function (files) {
      var f = files[0]; if (!f) return;
      if (el.player.src) URL.revokeObjectURL(el.player.src);
      el.player.src = URL.createObjectURL(f); el.player.hidden = false;
      el.file.textContent = 'Measuring ' + f.name + '…';
      try {
        var b = await global.AudioSaw.decodeToAudioBuffer(f);
        var r = global.ASBpm ? global.ASBpm.analyse(b) : null;
        el.file.textContent = r && r.bpm ? f.name + ' measures ' + r.bpm.toFixed(1) + ' BPM (or ' + (r.bpm / 2).toFixed(1) + ' / ' + (r.bpm * 2).toFixed(1) + '). Press play and tap along to compare.' : 'Press play and tap along.';
      } catch (e) { el.file.textContent = 'Press play and tap along.'; }
    });
  }

  show(null);
  global.__tap = { state: function () { return lastState; }, metro: function () { return el.metro.hidden ? null : el.metro.getAttribute('href'); }, file: function () { return el.file.textContent; } };
})(window);
