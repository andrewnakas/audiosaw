/*
 * /music-visualizer page controller. The pictures are Butterchurn (Jordan
 * Berg, MIT), a WebGL 2 implementation of MilkDrop, with the 100 presets of
 * butterchurn-presets, both from /vendor/butterchurn/2.6.7/ and loaded only
 * when a source is chosen.
 *
 * A file plays through an <audio> element (so an hour-long mix streams
 * instead of being decoded into memory) into the visualiser and the
 * speakers. The microphone goes into the visualiser only: sent to the
 * speakers it would feed back.
 *
 * Two things can be saved, both through CV.downloadBlob, so both count as
 * this page's convert_success: a PNG of the current frame, and a video
 * recorded in real time from the canvas and the file's own audio
 * (MediaRecorder: MP4 where the browser writes it, WebM otherwise). The
 * recording is the canvas as shown, so its size is the canvas's.
 */
(function (global) {
  'use strict';
  var CV = global.CV;
  if (!CV) { console.error('[visualizer] the /js/* includes must come before visualizer-page.js'); return; }
  var $ = CV.$;
  var V = '/vendor/butterchurn/2.6.7/';
  var el = {
    dropzone: $('#dropzone'), fileInput: $('#fileInput'), status: $('#status'), view: $('#vzView'), canvas: $('#vzCanvas'),
    wrap: $('#vzWrap'), audio: $('#vzAudio'), mic: $('#vzMic'), preset: $('#vzPreset'), next: $('#vzNext'), cycle: $('#vzCycle'),
    full: $('#vzFull'), png: $('#vzPng'), rec: $('#vzRec'), size: $('#vzSize'), name: $('#vzName')
  };
  if (!el.dropzone || !el.canvas) return;

  var ctx = null, viz = null, presets = null, names = [], libs = null;
  var fileNode = null, micNode = null, micStream = null, recDest = null, tap = null;
  var raf = 0, cycleTimer = 0, fileName = 'visualizer', recorder = null, recChunks = [], recStart = 0, recTick = 0;

  function script(src) {
    return new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = V + src;
      s.onload = res;
      s.onerror = function () { rej(new Error('Could not load ' + src)); };
      document.head.appendChild(s);
    });
  }

  function loadLibs() {
    if (!libs) {
      libs = Promise.all([script('butterchurn.min.js'), script('butterchurnPresets-2.4.7.min.js')]).then(function () {
        var p = global.butterchurnPresets;
        presets = (p.getPresets ? p : p.default).getPresets();
        names = Object.keys(presets).sort(function (a, b) { return a.toLowerCase() < b.toLowerCase() ? -1 : 1; });
        names.forEach(function (n) {
          var o = document.createElement('option');
          o.value = n; o.textContent = n;
          el.preset.appendChild(o);
        });
      });
      libs.catch(function () { libs = null; });
    }
    return libs;
  }

  function dims() {
    var v = el.size.value.split('x');
    return { w: +v[0], h: +v[1] };
  }

  // Everything that needs a user gesture is made here, inside the click or
  // drop that asked for it: a context made after an awaited permission
  // prompt can stay suspended (see /dictation).
  function engine() {
    if (ctx) return;
    var AC = global.AudioContext || global.webkitAudioContext;
    ctx = new AC();
    // One node in front of the visualiser, so file and microphone can swap
    // without telling Butterchurn.
    tap = ctx.createGain();
    recDest = ctx.createMediaStreamDestination();
  }

  function setup() {
    if (viz) return;
    var d = dims();
    el.canvas.width = d.w; el.canvas.height = d.h;
    var B = global.butterchurn.default || global.butterchurn;
    viz = B.createVisualizer(ctx, el.canvas, { width: d.w, height: d.h, pixelRatio: 1 });
    viz.connectAudio(tap);
    pick(names[Math.floor(Math.random() * names.length)], 0);
    frame();
    setCycle();
  }

  function frame() {
    raf = requestAnimationFrame(frame);
    viz.render();
  }

  function pick(name, blend) {
    if (!viz || !presets[name]) return;
    viz.loadPreset(presets[name], blend == null ? 2 : blend);
    el.preset.value = name;
    el.name.textContent = name;
  }

  function nextPreset() {
    var i = names.indexOf(el.preset.value), j = i;
    while (names.length > 1 && j === i) j = Math.floor(Math.random() * names.length);
    pick(names[j]);
  }

  function setCycle() {
    clearInterval(cycleTimer);
    var s = +el.cycle.value;
    if (s > 0) cycleTimer = setInterval(nextPreset, s * 1000);
  }

  function noWebgl() {
    try { return !document.createElement('canvas').getContext('webgl2'); } catch (e) { return true; }
  }

  function begin(kind) {
    if (noWebgl()) {
      CV.setStatus(el.status, 'error', 'This browser has no WebGL 2, which the visualiser draws with. Try a current Chrome, Firefox, Edge or Safari.');
      return Promise.reject(new Error('unsupported'));
    }
    engine();
    if (ctx.state === 'suspended') ctx.resume();
    CV.setStatus(el.status, 'info', 'Loading the visualiser…');
    return loadLibs().then(function () {
      el.view.hidden = false;
      setup();
      CV.clearStatus(el.status);
      el.rec.disabled = kind !== 'file';
      el.rec.title = kind === 'file' ? '' : 'Recording needs a file: the microphone is not recorded.';
    });
  }

  function stopMic() {
    if (micNode) { try { micNode.disconnect(); } catch (e) {} micNode = null; }
    if (micStream) { micStream.getTracks().forEach(function (t) { t.stop(); }); micStream = null; }
    el.mic.textContent = 'Use the microphone';
  }

  CV.bindDropzone(el.dropzone, el.fileInput, function (files) {
    var f = files[0];
    if (!f) return;
    stopMic();
    begin('file').then(function () {
      fileName = f.name.replace(/\.[^.]+$/, '');
      if (el.audio.src) URL.revokeObjectURL(el.audio.src);
      el.audio.src = URL.createObjectURL(f);
      el.audio.hidden = false;
      // A media element can be wired to a context once only.
      if (!fileNode) {
        fileNode = ctx.createMediaElementSource(el.audio);
        fileNode.connect(tap);
        fileNode.connect(ctx.destination);
        fileNode.connect(recDest);
      }
      el.audio.play().catch(function () {});
    }, function () {});
  });

  el.audio.addEventListener('error', function () {
    if (!el.audio.src) return;
    CV.setStatus(el.status, 'error', 'This browser cannot play that file. Try an MP3, WAV, M4A, OGG or FLAC, or convert it first.', new Error('decode: media element error'));
  });

  el.mic.addEventListener('click', function () {
    if (micStream) { stopMic(); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      CV.setStatus(el.status, 'error', 'This browser does not offer the microphone to web pages.', new Error('getUserMedia is not supported'));
      return;
    }
    var started = begin('mic');
    // Processing off: echo cancellation and noise suppression flatten music.
    navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } }).then(function (stream) {
      return started.then(function () {
        el.audio.pause();
        micStream = stream;
        micNode = ctx.createMediaStreamSource(stream);
        micNode.connect(tap);
        el.mic.textContent = 'Stop the microphone';
      });
    }).catch(function (e) {
      if (e && e.message === 'unsupported') return;
      CV.setStatus(el.status, 'error', 'The microphone could not be opened. ' + (e.message || e), e);
    });
  });

  el.preset.addEventListener('change', function () { pick(el.preset.value); });
  el.next.addEventListener('click', nextPreset);
  el.cycle.addEventListener('change', setCycle);
  el.size.addEventListener('change', function () {
    if (!viz) return;
    var d = dims();
    el.canvas.width = d.w; el.canvas.height = d.h;
    viz.setRendererSize(d.w, d.h);
  });
  el.full.addEventListener('click', function () {
    var w = el.wrap;
    (w.requestFullscreen || w.webkitRequestFullscreen || function () {}).call(w);
  });

  el.png.addEventListener('click', function () {
    if (!viz) return;
    // A WebGL canvas is cleared after it is shown; drawing and reading in
    // the same task is what makes the PNG the frame and not a blank.
    viz.render();
    el.canvas.toBlob(function (b) {
      if (b) CV.downloadBlob(b, fileName + '-visualizer.png');
    }, 'image/png');
  });

  function recType() {
    var types = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
    for (var i = 0; i < types.length; i++) if (global.MediaRecorder && MediaRecorder.isTypeSupported(types[i])) return types[i];
    return '';
  }

  function stopRec() {
    if (recorder && recorder.state !== 'inactive') recorder.stop();
  }

  el.rec.addEventListener('click', function () {
    if (recorder && recorder.state !== 'inactive') { stopRec(); return; }
    var type = recType();
    if (!type || !el.canvas.captureStream) {
      CV.setStatus(el.status, 'error', 'This browser cannot record the canvas to a video file.', new Error('MediaRecorder is not supported'));
      return;
    }
    if (!fileNode) return;
    var stream = el.canvas.captureStream(30);
    recDest.stream.getAudioTracks().forEach(function (t) { stream.addTrack(t); });
    recChunks = [];
    recorder = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 8000000, audioBitsPerSecond: 256000 });
    recorder.ondataavailable = function (e) { if (e.data && e.data.size) recChunks.push(e.data); };
    recorder.onstop = function () {
      clearInterval(recTick);
      el.rec.textContent = 'Record a video';
      el.size.disabled = false;
      var ext = type.indexOf('mp4') > 0 ? 'mp4' : 'webm';
      var blob = new Blob(recChunks, { type: type.split(';')[0] });
      recChunks = [];
      if (!blob.size) { CV.setStatus(el.status, 'error', 'The recording came out empty.', new Error('encode: empty recording')); return; }
      CV.downloadBlob(blob, fileName + '-visualizer.' + ext);
      CV.setStatus(el.status, 'success', 'Saved ' + fileName + '-visualizer.' + ext + ' (' + (blob.size / 1048576).toFixed(1) + ' MB).');
    };
    // The song from its start, so the video is the whole track.
    el.audio.currentTime = 0;
    el.audio.play().catch(function () {});
    recorder.start(1000);
    recStart = Date.now();
    // Changing the canvas size mid-recording breaks the encoder's stream.
    el.size.disabled = true;
    el.rec.textContent = 'Stop and save (0:00)';
    recTick = setInterval(function () {
      var s = Math.floor((Date.now() - recStart) / 1000);
      el.rec.textContent = 'Stop and save (' + Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2) + ')';
    }, 1000);
    CV.setStatus(el.status, 'info', 'Recording in real time. It stops by itself when the song ends; keep this tab in front, because a hidden tab stops drawing.');
  });

  el.audio.addEventListener('ended', stopRec);

  // For the check: the live objects, never used by the page itself.
  global.__vz = { render: function () { if (viz) viz.render(); }, state: function () { return { ctx: ctx && ctx.state, viz: !!viz, presets: names.length, preset: el.preset.value, rec: recorder && recorder.state }; } };
})(window);
