/*
 * /audio-to-sheet-music page controller.
 *
 * Decode -> pitch-track.js (YIN frames, notes, re-articulations split by
 * ASSheet.rearticulate) -> tempo and first beat from the note onsets
 * (ASSheet.tempo) -> key from key-detect.js -> ASSheet.quantize ->
 * MusicXML, drawn by OpenSheetMusicDisplay (BSD-3, vendored in
 * /vendor/osmd/, loaded only when there is something to draw).
 *
 * Tempo, time signature, transposition, clef and title redraw from the
 * stored notes without listening again. Downloads: MusicXML (MuseScore,
 * Sibelius, Finale, Dorico), MIDI, and a printable page (PDF from the
 * browser's print dialog).
 */
(function () {
  'use strict';

  if (typeof CV === 'undefined' || typeof AudioSaw === 'undefined' || typeof ASSheet === 'undefined' || typeof ASPitch === 'undefined') {
    console.error('[audio-to-sheet-music] the /js/* includes must come before sheet-page.js');
    return;
  }

  var $ = CV.$;
  var OSMD_SRC = '/vendor/osmd/opensheetmusicdisplay.min.js?v=2.2.0';
  var MAX_SECONDS = 10 * 60;

  var dropzone = $('#dropzone');
  var fileInput = $('#fileInput');
  var fileList = $('#fileList');
  var controls = $('#controls');
  var goBtn = $('#convertBtn');
  var statusEl = $('#status');
  var progressWrap = $('#progressWrap');
  var progressBar = $('#progressBar');
  var result = $('#result');
  var scoreEl = $('#score');
  var rangeSel = $('#range');
  var bpmIn = $('#bpm');
  var sigSel = $('#sig');
  var trSel = $('#transpose');
  var clefSel = $('#clef');
  var titleIn = $('#title');
  var keyOut = $('#keyOut');
  var xmlBtn = $('#xmlBtn');
  var midiBtn = $('#midiBtn');
  var printBtn = $('#printBtn');
  var playBtn = $('#playBtn');

  if (!dropzone || !goBtn) return;

  var file = null, notes = null, key = null, firstBeat = 0, detectedBpm = 0, xml = '', osmd = null, osmdLoading = null;
  var ctx = null, playing = [];

  function step(p, msg) {
    progressWrap.style.display = '';
    CV.setProgress(progressBar, p);
    if (msg) CV.setStatus(statusEl, 'info', msg);
  }
  function tick() { return new Promise(function (r) { setTimeout(r, 0); }); }

  function onFiles(picked) {
    var f = picked && picked[0];
    if (!f) return;
    file = f;
    fileList.style.display = '';
    CV.renderFileList(fileList, [f], function () { file = null; fileList.innerHTML = ''; controls.style.display = 'none'; });
    controls.style.display = '';
    goBtn.disabled = false;
    if (titleIn && !titleIn.dataset.edited) titleIn.value = f.name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ');
  }
  CV.bindDropzone(dropzone, fileInput, onFiles,
    ['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.oga', '.opus', '.webm', '.aif', '.aiff', '.caf', '.wma', '.amr', '.mp4', '.mov']);
  if (titleIn) titleIn.addEventListener('input', function () { titleIn.dataset.edited = '1'; draw(); });

  async function analyse() {
    if (!file) return;
    goBtn.disabled = true;
    try {
      step(5, 'Decoding…');
      var buf = await AudioSaw.decodeToAudioBuffer(file);
      if (buf.duration > MAX_SECONDS) throw new Error('That recording is over 10 minutes long. Cut out the part you want first; a page of notation is a minute or two of music.');
      var chans = [];
      for (var c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));
      var mono = chans.length === 1 ? chans[0] : ASSilence.toMono(chans);
      step(20, 'Following the pitch…');
      await tick();
      var range = (rangeSel ? rangeSel.value : '65-1600').split('-').map(parseFloat);
      var frames = ASPitch.track(mono, buf.sampleRate, { minHz: range[0], maxHz: range[1] });
      step(60, 'Finding the notes…');
      await tick();
      var found = ASSheet.rearticulate(ASPitch.segment(frames, { minClarity: 0.55, minNoteSec: 0.06 }), frames);
      if (found.length < 4) throw new Error('No clear melody found. This writes out one line, a voice or one instrument; a full mix or chords have no single note to follow.');
      step(75, 'Finding the beat and the key…');
      await tick();
      var tm = ASSheet.tempo(found);
      detectedBpm = tm ? tm.bpm : 100;
      firstBeat = tm ? tm.firstBeat : found[0].start;
      try { var KD = window.ASKey; key = KD ? KD.analyse(chans, buf.sampleRate) : null; } catch (e) { key = null; }
      notes = found;
      if (bpmIn) bpmIn.value = Math.round(detectedBpm);
      if (CV.signal) CV.signal.input(found.length + ' notes, ' + Math.round(detectedBpm) + ' BPM' + (key ? ', ' + key.name : ''));
      CV.setProgress(progressBar, 100);
      result.hidden = false;
      await draw();
      CV.setStatus(statusEl, 'success', found.length + ' notes at ' + Math.round(detectedBpm) + ' BPM' + (key ? ' in ' + key.name : '') +
        '. Check the tempo and time signature below; the score redraws as you change them.');
      result.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) {
      CV.setStatus(statusEl, 'error', 'Could not write out the music. ' + (e.message || e), e);
    }
    goBtn.disabled = false;
  }
  goBtn.addEventListener('click', analyse);

  function settings() {
    var bpm = +(bpmIn && bpmIn.value) || detectedBpm || 100;
    var sig = (sigSel ? sigSel.value : '4/4').split('/').map(Number);
    var tr = +(trSel && trSel.value) || 0;
    var fifths = key ? ASSheet.fifthsOf((key.pc + tr + 120) % 12, key.mode) : 0;
    return { bpm: bpm, sig: sig, transpose: tr, fifths: fifths, mode: key ? key.mode : undefined, clef: clefSel ? clefSel.value : 'auto', title: (titleIn && titleIn.value) || 'Melody' };
  }

  // The first beat stays where it was detected; a typed tempo keeps it, so
  // changing 96 to 48 halves every note's value rather than moving bar one.
  function quantized(o) { return ASSheet.quantize(notes, { bpm: o.bpm, firstBeat: firstBeat }); }

  function loadOsmd() {
    if (window.opensheetmusicdisplay) return Promise.resolve();
    if (osmdLoading) return osmdLoading;
    osmdLoading = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = OSMD_SRC;
      s.onload = resolve;
      s.onerror = function () { osmdLoading = null; reject(new Error('The notation display could not be loaded. Check the connection; the MusicXML download still works.')); };
      document.head.appendChild(s);
    });
    return osmdLoading;
  }

  var drawing = null;
  async function draw() {
    if (!notes) return;
    var o = settings();
    xml = ASSheet.toMusicXML(quantized(o), o);
    if (keyOut) keyOut.textContent = key ? key.name + (o.transpose ? ' (written ' + (o.transpose > 0 ? '+' : '') + o.transpose + ' semitones)' : '') : 'not clear';
    try {
      await loadOsmd();
      if (!osmd) osmd = new opensheetmusicdisplay.OpenSheetMusicDisplay(scoreEl, { autoResize: true, drawTitle: true, drawingParameters: 'compacttight' });
      var mine = drawing = {};
      await osmd.load(xml);
      if (mine !== drawing) return;
      osmd.render();
    } catch (e) {
      scoreEl.textContent = (e && e.message) || 'The score could not be drawn.';
    }
  }
  [bpmIn, sigSel, trSel, clefSel].forEach(function (el) { if (el) el.addEventListener('change', draw); });

  function base() { return ((titleIn && titleIn.value) || (file && file.name.replace(/\.[^.]+$/, '')) || 'melody').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'melody'; }

  if (xmlBtn) xmlBtn.addEventListener('click', function () {
    if (!xml) return;
    CV.downloadBlob(new Blob([xml], { type: 'application/vnd.recordare.musicxml+xml' }), base() + '.musicxml');
  });
  if (midiBtn) midiBtn.addEventListener('click', function () {
    if (!notes) return;
    var o = settings(), beat = 60 / o.bpm;
    var ns = quantized(o).map(function (n) { return { midi: n.midi + o.transpose, start: n.at / 4 * beat, duration: n.len / 4 * beat, velocity: n.vel || 90 }; });
    CV.downloadBlob(ASMidi.blob(ns, { bpm: o.bpm, trackName: base() }), base() + '.mid');
  });
  if (printBtn) printBtn.addEventListener('click', function () {
    if (!xml) return;
    CV.track('convert_success', { tool: 'audio-to-sheet-music', target_format: 'pdf' });
    window.print();
  });

  // Play what is written: the quantized notes on a soft triangle, so the
  // score can be checked against the recording by ear.
  if (playBtn) playBtn.addEventListener('click', function () {
    if (playing.length) { playing.forEach(function (o) { try { o.stop(); } catch (e) {} }); playing = []; playBtn.textContent = '▶ Play the score'; return; }
    if (!notes) return;
    var C = window.AudioContext || window.webkitAudioContext;
    ctx = ctx || new C();
    if (ctx.state === 'suspended') ctx.resume();
    var o = settings(), beat = 60 / o.bpm, t0 = ctx.currentTime + 0.1, last = 0;
    quantized(o).forEach(function (n) {
      var t = t0 + n.at / 4 * beat, d = n.len / 4 * beat * 0.95;
      var osc = ctx.createOscillator(), g = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.value = 440 * Math.pow(2, (n.midi + o.transpose - 69) / 12);
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.25, t + 0.01); g.gain.setTargetAtTime(0, t + d - 0.03, 0.02);
      osc.connect(g); g.connect(ctx.destination);
      osc.start(t); osc.stop(t + d + 0.1);
      playing.push(osc);
      last = Math.max(last, t + d);
    });
    playBtn.textContent = '■ Stop';
    setTimeout(function () { playing = []; playBtn.textContent = '▶ Play the score'; }, (last - ctx.currentTime + 0.2) * 1000);
  });

  window.__sheet = { use: function (f) { onFiles([f]); }, analyse: analyse, xml: function () { return xml; }, rendered: function () { return scoreEl.querySelectorAll('svg').length; } };
})();
