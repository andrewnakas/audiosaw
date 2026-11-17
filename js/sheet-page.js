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
  var partSel = $('#part');
  var layoutSel = $('#layout');
  var rangeLabel = rangeSel ? rangeSel.closest('label') : null;

  if (!dropzone || !goBtn) return;

  var file = null, notes = null, key = null, firstBeat = 0, detectedBpm = 0, xml = '', osmd = null, osmdLoading = null;
  var ctx = null, playing = [];
  var midi = null;   // the parsed file, when a .mid was dropped

  function isMidiName(name) { return /\.(mid|midi|kar)$/i.test(name || ''); }
  function showEl(el, on) { var l = el && (el.closest('label') || el); if (l) l.hidden = !on; }

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
    midi = null;
    if (rangeLabel) rangeLabel.hidden = isMidiName(f.name);
    fileList.style.display = '';
    CV.renderFileList(fileList, [f], function () { file = null; fileList.innerHTML = ''; controls.style.display = 'none'; });
    controls.style.display = '';
    goBtn.disabled = false;
    if (titleIn && !titleIn.dataset.edited) titleIn.value = f.name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ');
  }
  CV.bindDropzone(dropzone, fileInput, onFiles,
    ['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.oga', '.opus', '.webm', '.aif', '.aiff', '.caf', '.wma', '.amr', '.mp4', '.mov', '.mid', '.midi', '.kar']);
  if (titleIn) titleIn.addEventListener('input', function () { titleIn.dataset.edited = '1'; draw(); });

  // A .mid already has its notes, tempo and usually its key: nothing to
  // listen for. Notes are placed by their beat in the file (b0/b1), so a
  // tempo change in the file does not shift the bars.
  function keyFromFifths(fifths, mode) {
    var majorPc = ((fifths * 7) % 12 + 12) % 12;
    var pc = mode === 'minor' ? (majorPc + 9) % 12 : majorPc;
    var KD = window.ASKey;
    return { pc: pc, mode: mode, name: KD ? KD.keyName(pc, mode) : '' };
  }
  function midiNotes() {
    if (!midi) return [];
    var pick = partSel ? partSel.value : 'all';
    var out = [];
    midi.parts.forEach(function (p, i) {
      if (p.drums) return;
      if (pick !== 'all' && +pick !== i) return;
      p.notes.forEach(function (n) { out.push(n); });
    });
    return out.sort(function (a, b) { return a.start - b.start || a.midi - b.midi; });
  }
  // Two tonal parts, both chosen: usually a piano's two hands written on
  // their own tracks, or a tune and its accompaniment. Each gets a staff,
  // the higher one on top, so crossing hands stay on their own staff.
  function twoParts() {
    if (!midi || (partSel && partSel.value !== 'all')) return null;
    var tonal = midi.parts.filter(function (p) { return !p.drums; });
    if (tonal.length !== 2) return null;
    function mean(p) { return p.notes.reduce(function (a, n) { return a + n.midi; }, 0) / p.notes.length; }
    return mean(tonal[0]) >= mean(tonal[1]) ? tonal : [tonal[1], tonal[0]];
  }
  function defaultLayout(ns) {
    if (twoParts()) return 'parts';
    if (!ns.length) return 'melody';
    var lo = 127, hi = 0, overlap = 0;
    ns.forEach(function (n, i) {
      lo = Math.min(lo, n.midi); hi = Math.max(hi, n.midi);
      var nx = ns[i + 1];
      if (nx && nx.start < n.start + n.duration - 0.05) overlap++;
    });
    if (overlap < ns.length * 0.1) return 'melody';
    return lo < 55 && hi >= 64 ? 'piano' : 'chords';
  }
  async function analyseMidi() {
    step(10, 'Reading the MIDI file…');
    var parsed = ASMidiRead.parse(await file.arrayBuffer());
    if (!parsed.ppq) throw new Error('This MIDI file counts time in SMPTE frames rather than beats, so it has no bars to write out.');
    var tonal = parsed.parts.filter(function (p) { return !p.drums; });
    if (!tonal.length) throw new Error('This MIDI file has only drums on channel 10. Drum notation is not written out here.');
    midi = parsed;
    if (partSel) {
      partSel.innerHTML = '';
      var all = document.createElement('option');
      all.value = 'all'; all.textContent = tonal.length > 1 ? 'All ' + tonal.length + ' parts together' : (tonal[0].name || 'The part');
      partSel.appendChild(all);
      if (tonal.length > 1) parsed.parts.forEach(function (p, i) {
        if (p.drums) return;
        var op = document.createElement('option');
        op.value = String(i); op.textContent = (p.name || 'Part ' + (i + 1)) + ' (' + p.notes.length + ' notes)';
        partSel.appendChild(op);
      });
      showEl(partSel, tonal.length > 1);
    }
    var ns = midiNotes();
    if (layoutSel) {
      var po = layoutSel.querySelector('option[value="parts"]');
      if (po) po.hidden = po.disabled = !twoParts();
      layoutSel.value = defaultLayout(ns);
      showEl(layoutSel, true);
    }
    detectedBpm = parsed.bpm || 120;
    firstBeat = 0;
    if (parsed.key) key = keyFromFifths(parsed.key.fifths, parsed.key.mode);
    else {
      var pcs = new Float64Array(12);
      ns.forEach(function (n) { pcs[n.midi % 12] += n.duration; });
      try { var KD = window.ASKey; key = KD ? KD.fromChroma(pcs) : null; } catch (e) { key = null; }
    }
    if (sigSel && parsed.sig) {
      var want = parsed.sig.join('/');
      if ([].some.call(sigSel.options, function (op) { return op.value === want; })) sigSel.value = want;
    }
    notes = ns;
    if (bpmIn) bpmIn.value = Math.round(detectedBpm);
    var parts = tonal.length;
    if (CV.signal) CV.signal.input('MIDI, ' + ns.length + ' notes in ' + parts + ' part' + (parts > 1 ? 's' : '') + ', ' + Math.round(detectedBpm) + ' BPM' + (key ? ', ' + key.name : ''));
    CV.setProgress(progressBar, 100);
    result.hidden = false;
    await draw();
    CV.setStatus(statusEl, 'success', ns.length + ' notes' + (parts > 1 ? ' from ' + parts + ' parts' : '') + ' at ' + Math.round(detectedBpm) + ' BPM' + (key ? ' in ' + key.name : '') +
      (parsed.tempoChanges ? '. The file changes tempo ' + parsed.tempoChanges + ' time' + (parsed.tempoChanges > 1 ? 's' : '') + '; the bars follow its beats, and the first tempo is written' : '') +
      '. Pick the layout below; the score redraws as you change it.');
    result.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function analyse() {
    if (!file) return;
    goBtn.disabled = true;
    if (isMidiName(file.name)) {
      try { await analyseMidi(); }
      catch (e) { CV.setStatus(statusEl, 'error', 'Could not write out the MIDI file. ' + (e.message || e), e); }
      goBtn.disabled = false;
      return;
    }
    midi = null;
    showEl(partSel, false); showEl(layoutSel, false);
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
    return { bpm: bpm, sig: sig, transpose: tr, fifths: fifths, mode: key ? key.mode : undefined, clef: clefSel ? clefSel.value : 'auto', title: (titleIn && titleIn.value) || (midi ? 'Score' : 'Melody') };
  }

  // The first beat stays where it was detected; a typed tempo keeps it, so
  // changing 96 to 48 halves every note's value rather than moving bar one.
  // -> { q, lower }: what toMusicXML writes. From a MIDI file the layout
  // picks one melody line, one staff of chords, or a piano grand staff
  // split at middle C.
  function staves(o) {
    if (!midi) return { q: ASSheet.quantize(notes, { bpm: o.bpm, firstBeat: firstBeat }) };
    var lay = layoutSel ? layoutSel.value : 'chords';
    var tp = lay === 'parts' && twoParts();
    if (tp) return { q: ASSheet.quantizeChords(tp[0].notes), lower: ASSheet.quantizeChords(tp[1].notes) };
    if (lay === 'piano' || lay === 'parts') {
      return {
        q: ASSheet.quantizeChords(notes.filter(function (n) { return n.midi >= 60; })),
        lower: ASSheet.quantizeChords(notes.filter(function (n) { return n.midi < 60; }))
      };
    }
    var ch = ASSheet.quantizeChords(notes);
    return { q: lay === 'melody' ? ASSheet.topLine(ch) : ch };
  }
  // Every written note as { midi, at, len, vel }, for playback and the .mid.
  function quantized(o) {
    var st = staves(o), out = [];
    [st.q, st.lower || []].forEach(function (list) {
      list.forEach(function (n) { (n.midis || [n.midi]).forEach(function (m) { out.push({ midi: m, at: n.at, len: n.len, vel: n.vel }); }); });
    });
    return out.sort(function (a, b) { return a.at - b.at || a.midi - b.midi; });
  }

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
    var st = staves(o);
    o.lower = st.lower;
    if (clefSel) clefSel.disabled = !!st.lower;
    xml = ASSheet.toMusicXML(st.q, o);
    if (keyOut) keyOut.textContent = key ? key.name + (o.transpose ? ' (written ' + (o.transpose > 0 ? '+' : '') + o.transpose + ' semitones)' : '') : 'not clear';
    try {
      await loadOsmd();
      if (!osmd) osmd = new opensheetmusicdisplay.OpenSheetMusicDisplay(scoreEl, { autoResize: true, drawTitle: true, autoBeam: true, drawingParameters: 'compacttight' });
      var mine = drawing = {};
      await osmd.load(xml);
      if (mine !== drawing) return;
      osmd.render();
    } catch (e) {
      scoreEl.textContent = (e && e.message) || 'The score could not be drawn.';
    }
  }
  [bpmIn, sigSel, trSel, clefSel, layoutSel].forEach(function (el) { if (el) el.addEventListener('change', draw); });
  if (partSel) partSel.addEventListener('change', function () {
    notes = midiNotes();
    if (layoutSel) {
      var po = layoutSel.querySelector('option[value="parts"]');
      if (po) po.hidden = po.disabled = !twoParts();
      layoutSel.value = defaultLayout(notes);
    }
    draw();
  });

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
    CV.track('convert_success', { tool: location.pathname.replace(/^\/|\.html$/g, '') || 'audio-to-sheet-music', target_format: 'pdf' });
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
