/*
 * /mic-test. Opens the microphone, shows what the browser is actually
 * delivering (device, rate, channels, and whether echo cancellation, noise
 * suppression and auto gain are on), meters each channel in dBFS, measures
 * the noise floor, and records a short clip to play back.
 *
 * Three readings carry the diagnosis, because they are the three ways a
 * microphone "doesn't work" for people:
 *   - digital silence: every sample exactly 0. That is a mute somewhere
 *     upstream of the page (a hardware switch, the OS privacy setting, a
 *     muted input), never a quiet room, which always has some noise;
 *   - too quiet: the loudest moment in the last few seconds under -40 dBFS;
 *   - clipping: samples at full scale.
 * A dead side on a stereo input is reported too: a one-capsule USB mic or
 * input 1 of an interface often arrives as stereo with one side empty.
 *
 * The AudioContext is made inside the click, before getUserMedia is awaited:
 * made after the permission prompt it can stay suspended and read zeros
 * (see dictation-page.js), which here would look exactly like a muted mic.
 */
(function (global) {
  'use strict';
  var CV = global.CV;
  if (!CV) { console.error('mic-test-page: CV missing — /js includes must come first'); return; }
  var $ = CV.$;

  var el = {
    start: $('#micStart'), dev: $('#micDevice'), proc: $('#micProc'), monitor: $('#micMonitor'),
    meters: $('#micMeters'), scope: $('#micScope'), verdict: $('#micVerdict'), info: $('#micInfo'),
    peak: $('#micPeak'), rms: $('#micRms'), floor: $('#micFloor'), clips: $('#micClips'),
    rec: $('#micRec'), player: $('#micPlayer'), save: $('#micSave'), status: $('#status')
  };
  if (!el.start) return;

  var REC_SECONDS = 5;
  var ctx = null, stream = null, src = null, splitter = null, analysers = [], bufs = [], raf = 0, timer = 0;
  var monitorGain = null, recNode = null, recorded = null, clip = null, counted = false;
  var held = [], heldAt = [], rmsHist = [], peakHist = [], clipCount = 0, zeroSince = 0, startedAt = 0;

  function esc(t) { return String(t).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function db(x) { return x > 0 ? 20 * Math.log10(x) : -Infinity; }
  function fmtDb(x) { return isFinite(x) ? x.toFixed(1) + ' dBFS' : '−∞'; }
  function supported() { return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && global.isSecureContext); }

  function constraints() {
    var on = !!(el.proc && el.proc.checked);
    var a = { echoCancellation: on, noiseSuppression: on, autoGainControl: on, channelCount: { ideal: 2 } };
    if (el.dev && el.dev.value) a.deviceId = { exact: el.dev.value };
    return { audio: a };
  }

  function explain(err) {
    var n = err && err.name;
    if (n === 'NotAllowedError' || n === 'SecurityError') {
      return 'Microphone permission was refused. Click the microphone or lock icon at the left of the address bar, set Microphone to Allow, and press Start again. ' +
        'On a Mac, also check System Settings › Privacy & Security › Microphone and make sure your browser is ticked; on Windows, Settings › Privacy › Microphone.';
    }
    if (n === 'NotFoundError' || n === 'OverconstrainedError') return 'No microphone was found. Plug one in (or pick another in the list) and press Start again.';
    if (n === 'NotReadableError' || n === 'AbortError') {
      return 'The microphone is there but could not be opened. Another app is probably holding it — Zoom, Teams, Discord, OBS or another tab. Close it and press Start again.';
    }
    return 'Could not open the microphone: ' + ((err && err.message) || 'unknown error') + '.';
  }

  async function listDevices() {
    if (!el.dev || !navigator.mediaDevices.enumerateDevices) return;
    var all = await navigator.mediaDevices.enumerateDevices();
    var ins = all.filter(function (d) { return d.kind === 'audioinput'; });
    var cur = stream && stream.getAudioTracks()[0] && stream.getAudioTracks()[0].getSettings().deviceId;
    el.dev.innerHTML = ins.map(function (d, i) {
      var label = d.label || ('Microphone ' + (i + 1));
      return '<option value="' + esc(d.deviceId) + '"' + (d.deviceId === cur ? ' selected' : '') + '>' + esc(label) + '</option>';
    }).join('');
    el.dev.closest('label').hidden = ins.length < 2;
  }

  function showInfo(track) {
    var s = track.getSettings ? track.getSettings() : {};
    var rate = s.sampleRate || ctx.sampleRate, ch = s.channelCount || src.channelCount;
    function yn(v) { return v === undefined ? 'not reported' : v ? 'on' : 'off'; }
    var rows = [
      ['Device', track.label || 'default'],
      ['Sample rate', rate ? rate.toLocaleString() + ' Hz' : 'not reported'],
      ['Channels', ch ? (ch === 1 ? '1 (mono)' : ch + ' (stereo)') : 'not reported'],
      ['Echo cancellation', yn(s.echoCancellation)],
      ['Noise suppression', yn(s.noiseSuppression)],
      ['Auto gain', yn(s.autoGainControl)]
    ];
    if (s.latency) rows.push(['Input latency', Math.round(s.latency * 1000) + ' ms']);
    el.info.innerHTML = rows.map(function (r) { return '<dt>' + r[0] + '</dt><dd>' + esc(String(r[1])) + '</dd>'; }).join('');
    el.info.hidden = false;
  }

  function buildMeters(n) {
    el.meters.innerHTML = '';
    for (var c = 0; c < n; c++) {
      var row = document.createElement('div');
      row.className = 'mic-meter';
      row.innerHTML = '<span class="mic-ch">' + (n === 1 ? 'Level' : c ? 'R' : 'L') + '</span>' +
        '<div class="mic-bar"><div class="mic-fill"></div><div class="mic-hold"></div></div>';
      el.meters.appendChild(row);
    }
  }

  // -60..0 dBFS across the bar.
  function pos(d) { return Math.max(0, Math.min(1, (d + 60) / 60)) * 100; }

  function frame() {
    raf = requestAnimationFrame(frame);
    var now = performance.now(), rows = el.meters.children, anyNonZero = false, framePeak = 0, frameRms = 0;
    for (var c = 0; c < analysers.length; c++) {
      var b = bufs[c];
      analysers[c].getFloatTimeDomainData(b);
      var pk = 0, sq = 0;
      for (var i = 0; i < b.length; i++) {
        var v = Math.abs(b[i]);
        if (v > pk) pk = v;
        sq += b[i] * b[i];
        if (v >= 0.999) clipCount++;
      }
      if (pk > 0) anyNonZero = true;
      var r = Math.sqrt(sq / b.length);
      if (pk > framePeak) framePeak = pk;
      if (r > frameRms) frameRms = r;
      if (!held[c] || pk >= held[c] || now - heldAt[c] > 1500) { held[c] = pk; heldAt[c] = now; }
      var row = rows[c];
      if (row) {
        row.querySelector('.mic-fill').style.width = pos(db(r) + 3) + '%';
        var h = row.querySelector('.mic-hold');
        h.style.left = pos(db(held[c])) + '%';
        h.classList.toggle('clip', held[c] >= 0.999);
      }
    }
    if (anyNonZero) zeroSince = 0; else if (!zeroSince) zeroSince = now;
    rmsHist.push(frameRms); peakHist.push([now, framePeak]);
    if (rmsHist.length > 300) rmsHist.shift();
    while (peakHist.length && now - peakHist[0][0] > 4000) peakHist.shift();
    drawScope();
  }

  function drawScope() {
    var cv = el.scope, g = cv.getContext('2d'), w = cv.clientWidth, h = cv.clientHeight, dpr = global.devicePixelRatio || 1;
    if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    var css = getComputedStyle(cv);
    g.strokeStyle = css.getPropertyValue('--rule') || '#ccc';
    g.beginPath(); g.moveTo(0, h / 2); g.lineTo(w, h / 2); g.stroke();
    var b = bufs[0];
    if (!b) return;
    g.strokeStyle = css.getPropertyValue('--amber') || '#c70';
    g.lineWidth = 1.5;
    g.beginPath();
    var step = b.length / w;
    for (var x = 0; x < w; x++) {
      var y = h / 2 - b[Math.floor(x * step)] * (h / 2 - 2);
      if (x) g.lineTo(x, y); else g.moveTo(x, y);
    }
    g.stroke();
  }

  // Twice a second: the numbers and the verdict. The noise floor is the 10th
  // percentile of the last ~5 s of frame levels, the same rule silence-gaps.js
  // uses for a file: the quiet moments between words, not the words.
  function readout() {
    var now = performance.now();
    var maxPeak = peakHist.reduce(function (m, p) { return Math.max(m, p[1]); }, 0);
    var sorted = rmsHist.slice().sort(function (a, b) { return a - b; });
    var floor = sorted.length ? sorted[Math.floor(sorted.length * 0.1)] : 0;
    var loud = sorted.length ? sorted[Math.floor(sorted.length * 0.95)] : 0;
    el.peak.textContent = fmtDb(db(maxPeak));
    el.rms.textContent = fmtDb(db(loud));
    el.floor.textContent = floor > 0 ? fmtDb(db(floor)) : 'none (exact digital zero)';
    // The analyser windows overlap from frame to frame, so this is a yes/no,
    // not a sample count.
    el.clips.textContent = clipCount ? 'yes' : 'none';

    var v, kind;
    if (zeroSince && now - zeroSince > 1500) {
      kind = 'bad';
      v = 'The browser is receiving digital silence: every sample is exactly zero. Something is muting the microphone before it reaches the page — a mute switch or button on the mic or headset, ' +
        'the input muted or at 0 in your system\'s sound settings, or (on a Mac) the browser unticked under Privacy & Security › Microphone. If you have more than one, try another device in the list.';
    } else if (now - startedAt < 2500) {
      kind = ''; v = 'Listening… say a few words at your normal distance.';
    } else if (maxPeak >= 0.999) {
      kind = 'warn'; v = 'Too loud: it is hitting full scale and clipping, which sounds harsh and cannot be undone. Turn the input gain down (or move back from the mic) until the peak stays under −3 dBFS.';
    } else if (db(maxPeak) < -40) {
      kind = 'warn'; v = 'Working, but very quiet. If you are speaking, raise the input level in your system\'s sound settings, move closer, or check you are talking into the front of the mic. A loud moment should reach −20 to −6 dBFS.';
    } else if (analysers.length === 2 && oneSided()) {
      kind = 'ok'; v = 'Working. Only one side of the stereo input has sound, which is normal for a single microphone on input 1 of an interface or a one-capsule USB mic. Most apps use it as mono.';
    } else if (db(maxPeak) > -40) {
      kind = 'ok'; v = 'Your microphone is working.' + (db(maxPeak) > -24 ? ' The level is healthy.' : ' It is on the quiet side; a little more gain would help.');
      if (db(floor) > -45) v += ' The background noise is fairly high (' + fmtDb(db(floor)) + '); a quieter room or turning off a fan will help.';
    }
    el.verdict.textContent = v || '';
    el.verdict.className = 'mic-verdict' + (kind ? ' ' + kind : '');
  }

  var sideMax = [0, 0];
  function oneSided() {
    for (var c = 0; c < 2; c++) sideMax[c] = Math.max(sideMax[c] * 0.995, held[c] || 0);
    return (sideMax[0] > 0.01 && sideMax[1] < sideMax[0] * 0.01) || (sideMax[1] > 0.01 && sideMax[0] < sideMax[1] * 0.01);
  }

  async function start() {
    if (!supported()) {
      CV.setStatus(el.status, 'error', 'This page needs microphone access, which browsers only give to a secure (https) page with a modern browser.', new Error('unsupported getUserMedia'));
      return;
    }
    var C = global.AudioContext || global.webkitAudioContext;
    ctx = ctx || new C({ latencyHint: 'interactive' });
    ctx.resume();
    el.start.disabled = true;
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints());
    } catch (err) {
      el.start.disabled = false;
      CV.setStatus(el.status, 'error', explain(err), err);
      return;
    }
    await ctx.resume();
    var track = stream.getAudioTracks()[0];
    src = ctx.createMediaStreamSource(stream);
    var n = Math.min(2, (track.getSettings && track.getSettings().channelCount) || src.channelCount || 1);
    splitter = ctx.createChannelSplitter(n);
    src.connect(splitter);
    analysers = []; bufs = [];
    for (var c = 0; c < n; c++) {
      var a = ctx.createAnalyser();
      a.fftSize = 2048;
      splitter.connect(a, c);
      analysers.push(a); bufs.push(new Float32Array(a.fftSize));
    }
    monitorGain = ctx.createGain();
    monitorGain.gain.value = el.monitor && el.monitor.checked ? 1 : 0;
    src.connect(monitorGain).connect(ctx.destination);
    held = []; heldAt = []; rmsHist = []; peakHist = []; clipCount = 0; zeroSince = 0; sideMax = [0, 0];
    startedAt = performance.now();
    buildMeters(n);
    showInfo(track);
    await listDevices();
    raf = requestAnimationFrame(frame);
    timer = setInterval(readout, 500);
    el.start.disabled = false;
    el.start.textContent = 'Stop';
    el.start.classList.add('is-on');
    el.rec.disabled = false;
    $('#micLive').hidden = false;
    CV.clearStatus(el.status);
    track.addEventListener('ended', function () {
      stop();
      CV.setStatus(el.status, 'warn', 'The microphone was disconnected or taken by another app.');
    });
  }

  function stop() {
    cancelAnimationFrame(raf); raf = 0;
    clearInterval(timer); timer = 0;
    if (recNode) finishRecording();
    if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
    stream = null;
    if (src) src.disconnect();
    el.start.textContent = 'Start the test';
    el.start.classList.remove('is-on');
    el.rec.disabled = true;
  }

  async function restart() { if (!stream) return; stop(); await start(); }

  /* ---------------------------------------------------------- recording */

  // A ScriptProcessor rather than MediaRecorder: the clip is the raw float
  // samples the meters were reading, so what you hear back is the
  // microphone, not a call codec's version of it.
  function record() {
    if (!stream || recNode) return;
    var n = analysers.length, size = 4096;
    recorded = []; for (var c = 0; c < n; c++) recorded.push([]);
    var need = Math.round(REC_SECONDS * ctx.sampleRate), got = 0;
    recNode = ctx.createScriptProcessor(size, n, n);
    var mute = ctx.createGain(); mute.gain.value = 0;
    recNode.onaudioprocess = function (e) {
      for (var c = 0; c < n; c++) recorded[c].push(new Float32Array(e.inputBuffer.getChannelData(c)));
      got += size;
      el.rec.textContent = 'Recording… ' + Math.max(0, Math.ceil((need - got) / ctx.sampleRate)) + ' s';
      if (got >= need) finishRecording();
    };
    src.connect(recNode); recNode.connect(mute).connect(ctx.destination);
    el.rec.classList.add('is-on');
  }

  function finishRecording() {
    if (!recNode) return;
    recNode.onaudioprocess = null;
    try { src.disconnect(recNode); recNode.disconnect(); } catch (e) {}
    recNode = null;
    el.rec.classList.remove('is-on');
    el.rec.textContent = 'Record ' + REC_SECONDS + ' seconds again';
    var chans = recorded.map(function (parts) {
      var len = parts.reduce(function (s, p) { return s + p.length; }, 0), out = new Float32Array(len), o = 0;
      parts.forEach(function (p) { out.set(p, o); o += p.length; });
      return out;
    });
    clip = AudioSaw.makeBuffer(chans, ctx.sampleRate);
    counted = false;
    AudioSaw.encode(clip, 'wav').then(function (blob) {
      clip.blob = blob;
      if (el.player.src) URL.revokeObjectURL(el.player.src);
      el.player.src = URL.createObjectURL(blob);
      el.player.hidden = false;
      el.save.hidden = false;
      // Headphones or not, hearing yourself while the monitor is on doubles
      // the sound; the playback is the point here.
      if (monitorGain) monitorGain.gain.value = 0;
      if (el.monitor) el.monitor.checked = false;
      el.player.play().catch(function () {});
    });
  }

  // Hearing the test clip to the end is what this page is for, so it counts
  // as a success the way a heard result does on /text-to-speech.
  el.player.addEventListener('ended', function () {
    if (counted) return;
    counted = true;
    CV.track('convert_success', { tool: 'mic-test', target_format: 'play' });
  });

  el.save.addEventListener('click', function () {
    if (clip && clip.blob) CV.downloadBlob(clip.blob, 'mic-test.wav');
  });

  el.start.addEventListener('click', function () { if (stream) stop(); else start(); });
  el.rec.addEventListener('click', record);
  if (el.dev) el.dev.addEventListener('change', restart);
  if (el.proc) el.proc.addEventListener('change', restart);
  if (el.monitor) el.monitor.addEventListener('change', function () {
    if (monitorGain) monitorGain.gain.value = el.monitor.checked ? 1 : 0;
  });
  if (!supported()) {
    CV.setStatus(el.status, 'warn', 'This browser does not offer microphone access on this page. Open it in current Chrome, Edge, Firefox or Safari over https.');
  }

  global.__micTest = { start: start, stop: stop, record: record, state: function () {
    return { peak: el.peak.textContent, floor: el.floor.textContent, verdict: el.verdict.textContent, info: el.info.textContent, channels: analysers.length, clip: clip && { rate: clip.sampleRate, length: clip.length } };
  } };
})(window);
