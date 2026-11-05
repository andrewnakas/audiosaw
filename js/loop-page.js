/*
 * /seamless-loop-maker page controller.
 *
 * The file is decoded at its own rate and its tempo measured (bpm-detector:
 * analyse for the tempo, phase for where the first beat falls), so the
 * starting selection is four bars from a beat. The start and end handles
 * are dragged on the waveform or typed. "Find the seamless point" moves the
 * end to where the sound best matches the start (js/loop-find.js); with
 * "whole bars" on, the length is exact bars at the tempo instead. Preview
 * plays the made loop on repeat (a looping AudioBufferSourceNode, so what
 * you hear is the file you get). The download is the loop, or the loop
 * repeated, encoded with CV.encodeBuffer.
 */
(function (global) {
  'use strict';
  var CV = global.CV, L = global.ASLoop;
  if (!CV || !L || !global.AudioSaw || !CV.encodeBuffer) { console.error('[seamless-loop-maker] the /js/* includes (with tool-shell.js) must come before loop-page.js'); return; }
  var $ = CV.$;
  var el = {
    dropzone: $('#dropzone'), fileInput: $('#fileInput'), fileList: $('#fileList'), status: $('#status'), work: $('#lpWork'),
    wave: $('#lpWave'), start: $('#lpStart'), end: $('#lpEnd'), len: $('#lpLen'), find: $('#lpFind'), bars: $('#lpBars'),
    bpm: $('#lpBpm'), beats: $('#lpBeats'), fade: $('#lpFade'), times: $('#lpTimes'), fmt: $('#outFmt'), bitrate: $('#bitrate'),
    play: $('#lpPlay'), save: $('#convertBtn'), note: $('#lpNote')
  };
  if (!el.dropzone || !el.wave) return;
  var file = null, buf = null, chans = null, sel = { s: 0, e: 0 }, peaks = null, actx = null, src = null;

  function rate() { return buf.sampleRate; }
  function fmt(s) { return s.toFixed(3); }
  function setSel(s, e, why) {
    var n = buf.length;
    s = Math.max(Math.round(0.05 * rate()) + 1, Math.min(n - 2, Math.round(s)));
    e = Math.max(s + Math.round(0.05 * rate()), Math.min(n, Math.round(e)));
    sel = { s: s, e: e };
    el.start.value = fmt(s / rate()); el.end.value = fmt(e / rate());
    var secs = (e - s) / rate(), b = +el.bpm.value, bar = b > 0 ? 60 / b * (+el.beats.value) : 0;
    el.len.textContent = secs.toFixed(3) + ' s' + (bar ? ' · ' + (secs / bar).toFixed(2) + ' bars at ' + b + ' BPM' : '');
    if (why) el.note.textContent = why;
    drawWave();
    if (src) { stop(); play(); }
  }

  function computePeaks() {
    var W = Math.max(300, Math.round(el.wave.clientWidth * (global.devicePixelRatio || 1))), n = buf.length, step = n / W;
    peaks = new Float32Array(W * 2);
    for (var x = 0; x < W; x++) {
      var a = Math.floor(x * step), b = Math.min(n, Math.floor((x + 1) * step)), lo = 0, hi = 0;
      for (var c = 0; c < chans.length; c++) for (var i = a; i < b; i++) { var v = chans[c][i]; if (v < lo) lo = v; if (v > hi) hi = v; }
      peaks[2 * x] = lo; peaks[2 * x + 1] = hi;
    }
  }
  function drawWave() {
    if (!buf) return;
    var dpr = global.devicePixelRatio || 1, W = el.wave.clientWidth, H = el.wave.clientHeight;
    el.wave.width = Math.round(W * dpr); el.wave.height = Math.round(H * dpr);
    if (!peaks || peaks.length / 2 !== el.wave.width) computePeaks();
    var g = el.wave.getContext('2d'), css = getComputedStyle(document.body);
    var ink = css.getPropertyValue('--ink').trim() || '#222', amber = css.getPropertyValue('--amber').trim() || '#c2410c', muted = css.getPropertyValue('--muted').trim() || '#999';
    var PW = el.wave.width, PH = el.wave.height, n = buf.length;
    g.clearRect(0, 0, PW, PH);
    var xs = sel.s / n * PW, xe = sel.e / n * PW;
    g.fillStyle = 'rgba(194,65,12,.12)'; g.fillRect(xs, 0, xe - xs, PH);
    for (var x = 0; x < PW; x++) {
      var lo = peaks[2 * x], hi = peaks[2 * x + 1];
      g.fillStyle = x >= xs && x <= xe ? ink : muted;
      g.fillRect(x, (1 - hi) * PH / 2, 1, Math.max(1, (hi - lo) * PH / 2));
    }
    g.fillStyle = amber; g.fillRect(xs - dpr, 0, 2 * dpr, PH); g.fillRect(xe - dpr, 0, 2 * dpr, PH);
    // Bar lines from the start, when a tempo is set.
    var b = +el.bpm.value;
    if (b > 0) {
      var bar = 60 / b * (+el.beats.value) * rate();
      g.fillStyle = 'rgba(194,65,12,.45)';
      for (var t = sel.s + bar; t < n; t += bar) g.fillRect(t / n * PW, PH - 8 * dpr, dpr, 8 * dpr);
      for (var t2 = sel.s - bar; t2 > 0; t2 -= bar) g.fillRect(t2 / n * PW, PH - 8 * dpr, dpr, 8 * dpr);
    }
  }

  // Dragging a handle (whichever is nearer).
  var drag = null;
  el.wave.addEventListener('pointerdown', function (ev) {
    if (!buf) return;
    var r = el.wave.getBoundingClientRect(), t = (ev.clientX - r.left) / r.width * buf.length;
    drag = Math.abs(t - sel.s) < Math.abs(t - sel.e) ? 's' : 'e';
    el.wave.setPointerCapture(ev.pointerId);
    move(ev);
  });
  function move(ev) {
    if (!drag) return;
    var r = el.wave.getBoundingClientRect(), t = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)) * buf.length;
    if (drag === 's') setSel(t, sel.e); else setSel(sel.s, t);
  }
  el.wave.addEventListener('pointermove', move);
  el.wave.addEventListener('pointerup', function () { drag = null; });
  el.start.addEventListener('change', function () { setSel(+el.start.value * rate(), sel.e); });
  el.end.addEventListener('change', function () { setSel(sel.s, +el.end.value * rate()); });
  [el.bpm, el.beats].forEach(function (x) { x.addEventListener('change', function () { if (buf) setSel(sel.s, sel.e); }); });

  function refine() {
    if (!buf) return;
    var useBars = el.bars.checked && +el.bpm.value > 0;
    var r = L.find(chans, rate(), { start: sel.s, end: sel.e, bpm: useBars ? +el.bpm.value : 0, beatsPerBar: +el.beats.value });
    setSel(r.start, r.end, useBars
      ? 'Exactly ' + r.bars + ' bar' + (r.bars > 1 ? 's' : '') + ' at ' + el.bpm.value + ' BPM (' + (r.end - r.start) + ' samples); the crossfade makes the join.'
      : 'Moved the end to where the sound best matches the start (match ' + Math.round(r.score * 100) + '%).');
    return r;
  }
  el.find.addEventListener('click', refine);

  function made() {
    var loop = L.make(chans, rate(), sel.s, sel.e, { fade: +el.fade.value / 1000 });
    return loop;
  }
  function stop() { if (src) { try { src.stop(); } catch (e) {} src = null; } el.play.textContent = 'Play the loop'; }
  function play() {
    var C = global.AudioContext || global.webkitAudioContext;
    actx = actx || new C({ sampleRate: rate() });
    actx.resume();
    var loop = made(), b = actx.createBuffer(loop.length, loop[0].length, rate());
    loop.forEach(function (y, i) { b.copyToChannel(y, i); });
    src = actx.createBufferSource(); src.buffer = b; src.loop = true; src.connect(actx.destination); src.start();
    el.play.textContent = 'Stop';
  }
  el.play.addEventListener('click', function () { if (!buf) return; if (src) stop(); else play(); });

  async function save() {
    if (!buf) return;
    try {
      el.save.disabled = true;
      var loop = made(), times = +el.times.value;
      if (times > 1) loop = L.repeat(loop, times);
      var out = CV.bufferFrom(loop, rate()); out.srcInfo = buf.srcInfo;
      CV.setStatus(el.status, 'info', 'Encoding…');
      var f = (el.fmt.value || 'wav').toLowerCase();
      var blob = await CV.encodeBuffer(out, f, el.bitrate.value);
      var name = AudioSaw.rename(file.name, f).replace(/\.([^.]+)$/, '-loop' + (times > 1 ? '-x' + times : '') + '.$1');
      CV.setStatus(el.status, 'success', 'Done: ' + ((sel.e - sel.s) / rate()).toFixed(3) + ' s loop' + (times > 1 ? ', repeated ' + times + ' times' : '') + '.');
      CV.downloadBlob(blob, name);
    } catch (e) { CV.setStatus(el.status, 'error', 'Could not make the loop. ' + (e.message || e), e); }
    el.save.disabled = false;
  }
  el.save.addEventListener('click', save);

  CV.bindDropzone(el.dropzone, el.fileInput, async function (files) {
    var f = files[0]; if (!f) return;
    stop();
    CV.renderFileList(el.fileList, [f], function () { buf = null; el.work.hidden = true; el.fileList.style.display = 'none'; });
    el.fileList.style.display = '';
    try {
      CV.setStatus(el.status, 'info', 'Reading ' + f.name + '…');
      var b = await global.AudioSaw.decodeToAudioBuffer(f);
      file = f; buf = b; chans = CV.channelsOf(b); peaks = null;
      el.work.hidden = false;
      el.save.disabled = false;
      var start = 0.05 * b.sampleRate, end = Math.min(b.length, start + 8 * b.sampleRate), why = '';
      if (global.ASBpm && b.duration > 3) {
        CV.setStatus(el.status, 'info', 'Finding the tempo…');
        await new Promise(function (r) { setTimeout(r, 0); });
        var t = global.ASBpm.analyse(b);
        if (t && t.bpm && t.confidence > 0.2) {
          el.bpm.value = Math.round(t.bpm * 100) / 100;
          var ph = global.ASBpm.phase(b, t.bpm, 4), beat = 60 / t.bpm;
          var first = ph ? (ph.downbeat != null ? ph.downbeat : ph.beat) || 0 : 0;
          if (first * b.sampleRate < 0.05 * b.sampleRate) first += beat;
          var barS = beat * (+el.beats.value) * b.sampleRate;
          start = first * b.sampleRate;
          end = start + Math.min(4, Math.max(1, Math.floor((b.length - start) / barS))) * barS;
          why = 'Tempo ' + el.bpm.value + ' BPM; the selection starts on the downbeat (a guess: move it if it is not beat one) and runs ' + Math.round((end - start) / barS) + ' bars.';
        }
      }
      CV.clearStatus(el.status);
      // clearStatus empties the "Your file" readout the decode filled in.
      if (CV.signal && b.srcInfo) CV.signal.input(AudioSaw.describeFormat(b.srcInfo));
      setSel(start, end, why || 'Drag the handles to choose the part to loop, then "Find the seamless point".');
    } catch (e) { CV.setStatus(el.status, 'error', 'Could not read that file. ' + (e.message || e), e); }
  });
  global.addEventListener('resize', function () { peaks = null; drawWave(); });

  global.__loop = { sel: function () { return { s: sel.s, e: sel.e, rate: buf && rate(), bpm: +el.bpm.value }; }, set: function (s, e) { setSel(s, e); }, refine: refine, save: save };
})(window);
