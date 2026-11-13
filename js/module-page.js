/*
 * /module-player page controller. A tracker module (MOD, XM, S3M, IT) is
 * rendered once through, offline, by js/module-worker.js over
 * vendor/modplay/1.0.0/modplay.wasm: 8bitbubsy's C ports of ProTracker 2,
 * Fasttracker 2 and Impulse Tracker 2 (BSD-3-Clause).
 *
 * The render is the thing both buttons use: it plays in an <audio> element
 * (from a 16-bit WAV made for the purpose) and is saved in the chosen format
 * through AudioSaw.encode and CV.downloadBlob, which makes the download the
 * page's convert_success.
 *
 * The replayers hand back the mix before their own 16-bit clip, so a loud
 * module can pass full scale. If it does, the whole song is turned down to
 * peak at -1 dBFS; a module under full scale is left exactly as rendered.
 */
(function (global) {
  'use strict';
  var CV = global.CV, A = global.AudioSaw;
  if (!CV || !A) { console.error('[module] the /js/* includes must come before module-page.js'); return; }
  var $ = CV.$;
  var Q = ((document.currentScript && document.currentScript.src) || '').replace(/^[^?]*/, '');
  var el = {
    dropzone: $('#dropzone'), fileInput: $('#fileInput'), fileList: $('#fileList'), status: $('#status'), progress: $('#progressBar'),
    view: $('#mdView'), title: $('#mdTitle'), facts: $('#mdFacts'), names: $('#mdNames'), audio: $('#mdAudio'),
    sep: $('#mdSep'), sepWrap: $('#mdSepWrap'), rate: $('#mdRate'), format: $('#mdFormat'), save: $('#convertBtn')
  };
  if (!el.dropzone || !el.view) return;
  var ACCEPT = ['.mod', '.xm', '.s3m', '.it'];
  var wrap = $('#progressWrap');
  var worker = null, job = 0, file = null, bytes = null, song = null, waiting = {};

  function startWorker() {
    if (worker) return worker;
    worker = new Worker('/js/module-worker.js' + Q);
    worker.onmessage = function (e) {
      var m = e.data, w = waiting[m.id];
      if (!w) return;
      if (m.progress != null) { if (m.id === job && el.progress) CV.setProgress(el.progress, Math.round(m.progress * 100)); return; }
      delete waiting[m.id];
      if (m.error) w.reject(new Error(m.error)); else w.resolve(m.result);
    };
    worker.onerror = function (e) {
      Object.keys(waiting).forEach(function (id) { waiting[id].reject(new Error('The module player stopped. ' + (e.message || ''))); });
      waiting = {};
      worker = null;
    };
    return worker;
  }

  function render() {
    var id = ++job;
    return new Promise(function (resolve, reject) {
      waiting[id] = { resolve: resolve, reject: reject };
      // A copy goes to the worker: the original is kept for the next render
      // at another rate or stereo width.
      var copy = bytes.slice(0);
      startWorker().postMessage({ id: id, bytes: copy, sampleRate: +el.rate.value, stereoSeparation: +el.sep.value }, [copy]);
    }).then(function (r) { return id === job ? r : null; });
  }

  function mmss(s) { return Math.floor(s / 60) + ':' + ('0' + Math.floor(s % 60)).slice(-2); }

  function show(r) {
    var L = new Float32Array(r.left), R = new Float32Array(r.right), i, turned = 0;
    var top = Math.pow(10, -1 / 20);
    if (r.peak > top) {
      var g = top / r.peak;
      for (i = 0; i < L.length; i++) { L[i] *= g; R[i] *= g; }
      turned = -20 * Math.log10(g);
    }
    var buf = new AudioBuffer({ length: r.frames, sampleRate: r.sampleRate, numberOfChannels: 2 });
    buf.copyToChannel(L, 0); buf.copyToChannel(R, 1);
    song = { buffer: buf, info: r.info, duration: r.duration, turned: turned, truncated: r.truncated };
    var inf = r.info;
    el.title.textContent = inf.title || file.name;
    el.facts.textContent = inf.format + ', played by ' + inf.player + ' · ' + inf.channels + ' channels · ' + inf.patterns + ' patterns, ' + inf.orders + ' positions · ' +
      mmss(r.duration) + (r.truncated ? ' (stopped at the 20-minute limit)' : ' once through');
    // The sample and instrument names are where module authors wrote their
    // greetings, so they are shown as the text they are.
    var names = inf.instruments.filter(function (n) { return n; });
    el.names.textContent = names.join('\n');
    el.names.parentNode.hidden = !names.length;
    el.sepWrap.hidden = !(inf.player === 'pt2-clone');
    el.view.hidden = false;
    return A.encode(buf, 'wav16', { quiet: true }).then(function (wav) {
      if (el.audio.src) URL.revokeObjectURL(el.audio.src);
      el.audio.src = URL.createObjectURL(wav);
      CV.setStatus(el.status, 'success', 'Rendered ' + mmss(r.duration) + ' at ' + r.sampleRate + ' Hz' +
        (turned ? ', turned down ' + turned.toFixed(1) + ' dB because the mix passed full scale' : '') + '. Press play, or save it.');
    });
  }

  function run() {
    if (!bytes) return Promise.resolve();
    el.save.disabled = true;
    CV.setStatus(el.status, 'info', 'Rendering ' + file.name + '…');
    if (wrap) { wrap.style.display = ''; CV.setProgress(el.progress, 0); }
    return render().then(function (r) {
      if (!r) return;
      return show(r);
    }).catch(function (e) {
      song = null;
      el.view.hidden = true;
      CV.setStatus(el.status, 'error', e.message || String(e), new Error('bad_file: ' + (e.message || e)));
    }).then(function () { el.save.disabled = !song; if (wrap) wrap.style.display = 'none'; });
  }

  CV.bindDropzone(el.dropzone, el.fileInput, function (files) {
    var f = files[0];
    if (!f) return;
    file = f; song = null;
    el.view.hidden = true;
    el.audio.pause();
    CV.renderFileList(el.fileList, [f], function () { file = null; bytes = null; song = null; job++; el.view.hidden = true; el.audio.pause(); el.fileList.style.display = 'none'; CV.clearStatus(el.status); });
    el.fileList.style.display = '';
    f.arrayBuffer().then(function (ab) { bytes = ab; return run(); }, function (e) {
      CV.setStatus(el.status, 'error', 'The browser could not read that file. ' + (e.message || e), e);
    });
  }, ACCEPT);

  // Both change the samples, so both mean rendering again.
  el.rate.addEventListener('change', run);
  el.sep.addEventListener('change', run);

  el.save.addEventListener('click', function () {
    if (!song) return;
    var fmt = el.format.value;
    el.save.disabled = true;
    CV.setStatus(el.status, 'info', 'Writing the file…');
    A.encode(song.buffer, fmt, {}).then(function (blob) {
      var name = file.name.replace(/\.[^.]+$/, '') + '.' + A.extFor(fmt);
      CV.downloadBlob(blob, name);
      CV.setStatus(el.status, 'success', 'Saved ' + name + ' (' + mmss(song.duration) + ', ' + (blob.size / 1048576).toFixed(1) + ' MB).');
    }).catch(function (e) {
      CV.setStatus(el.status, 'error', 'Could not write that file. ' + (e.message || e), e);
    }).then(function () { el.save.disabled = false; });
  });

  // For the check: the last render, never used by the page itself.
  global.__md = { song: function () { return song && { duration: song.duration, turned: song.turned, info: song.info, rate: song.buffer.sampleRate }; } };
})(window);
