/*
 * /dx7-synth page controller. The sound is js/dx7-core.js (ASDx7) over
 * vendor/msfa/2026-10-14/dx7.wasm: the MSFA six-operator FM engine
 * (Apache-2.0) as carried in Dexed.
 *
 * Live: one AudioWorklet (from a Blob URL, the wasm bytes handed over in
 * processorOptions) played from the on-screen keys, the computer keyboard
 * and Web MIDI. The context is made inside the Start click.
 *
 * Files: a .syx bank adds its voices to the voice list (read here, never
 * uploaded); a .mid is rendered through the chosen voice with the same
 * module, offline, and saved through AudioSaw.encode and CV.downloadBlob, so
 * the download is this page's convert_success. Twenty notes played live count
 * once as target_format 'play'.
 *
 * The engine's default gain leaves one voice near -23 dBFS and dense chords
 * can pass full scale, so a rendered file is scaled as a whole to peak at
 * -1 dBFS, up or down. Nothing is limited or compressed. Live, the volume
 * slider starts at 2x for the same reason.
 */
(function (global) {
  'use strict';
  var CV = global.CV, D = global.ASDx7, A = global.AudioSaw, MR = global.ASMidiRead;
  if (!CV || !D || !A || !MR) { console.error('[dx7] the /js/* includes must come before dx7-page.js'); return; }
  var $ = CV.$;
  var WASM = '/vendor/msfa/2026-10-14/dx7.wasm?v=1';
  var el = {
    start: $('#dxStart'), panel: $('#dxPanel'), voice: $('#dxVoice'), keys: $('#dxKeys'), oct: $('#dxOct'), vol: $('#dxVol'),
    midiBtn: $('#dxMidi'), midiNote: $('#dxMidiNote'), status: $('#status'), dropzone: $('#dropzone'), fileInput: $('#fileInput'),
    song: $('#dxSong'), songName: $('#dxSongName'), part: $('#dxPart'), format: $('#dxFormat'), render: $('#dxRender'), stop: $('#dxPanic')
  };
  if (!el.start || !el.keys) return;

  var wasmBytes = null, ctx = null, node = null, out = null;
  var voices = D.PATCHES.map(function (p) { return { name: p.name, data: p.data, from: 'Built in' }; });
  var octave = 4, held = {}, played = 0, counted = false, started = false, song = null, songFile = '';

  function fillVoices(select) {
    var groups = {}, order = [];
    voices.forEach(function (v, i) {
      if (!groups[v.from]) { groups[v.from] = []; order.push(v.from); }
      groups[v.from].push(i);
    });
    el.voice.innerHTML = '';
    order.forEach(function (g) {
      var og = document.createElement('optgroup');
      og.label = g;
      groups[g].forEach(function (i) {
        var o = document.createElement('option');
        o.value = i; o.textContent = voices[i].name.trim() || 'Voice ' + (i + 1);
        og.appendChild(o);
      });
      el.voice.appendChild(og);
    });
    if (select != null) el.voice.value = select;
  }

  function currentVoice() { return voices[+el.voice.value] || voices[0]; }

  function fetchWasm() {
    if (wasmBytes) return Promise.resolve(wasmBytes);
    return fetch(WASM).then(function (r) {
      if (!r.ok) throw new Error('The synth engine did not download (' + r.status + ').');
      return r.arrayBuffer();
    }).then(function (b) { wasmBytes = b; return b; });
  }

  // ---- live ----------------------------------------------------------------

  function post(m) { if (node) node.port.postMessage(m); }

  function noteOn(n, v) {
    if (!node || held[n] || n < 0 || n > 127) return;
    held[n] = true;
    post({ t: 'on', n: n, v: v == null ? 0.8 : v });
    var k = el.keys.querySelector('[data-n="' + n + '"]');
    if (k) k.classList.add('down');
    if (!started) { started = true; CV.track('convert_start', { tool: 'dx7-synth', target_format: 'play' }); }
    if (!counted && ++played >= 20) { counted = true; CV.track('convert_success', { tool: 'dx7-synth', target_format: 'play' }); }
  }

  function noteOff(n) {
    if (!held[n]) return;
    delete held[n];
    post({ t: 'off', n: n });
    var k = el.keys.querySelector('[data-n="' + n + '"]');
    if (k) k.classList.remove('down');
  }

  function panic() {
    Object.keys(held).forEach(function (n) { noteOff(+n); });
    post({ t: 'panic' });
  }

  function startLive() {
    // The context has to be made in the click itself: after an await it can
    // stay suspended (see /dictation).
    var AC = global.AudioContext || global.webkitAudioContext;
    if (!AC || !global.AudioWorkletNode) {
      CV.setStatus(el.status, 'error', 'This browser has no AudioWorklet, which the synth plays through. Try a current Chrome, Firefox, Edge or Safari.', new Error('AudioWorklet is not supported'));
      return;
    }
    ctx = new AC({ latencyHint: 'interactive' });
    el.start.disabled = true;
    CV.setStatus(el.status, 'info', 'Starting the synth…');
    var url = URL.createObjectURL(new Blob([D.workletSource()], { type: 'application/javascript' }));
    Promise.all([fetchWasm(), ctx.audioWorklet.addModule(url)]).then(function (r) {
      URL.revokeObjectURL(url);
      node = new AudioWorkletNode(ctx, 'as-dx7', {
        numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
        // A copy: the bytes are also needed here for rendering files.
        processorOptions: { wasm: r[0].slice(0), voice: currentVoice().data }
      });
      node.port.onmessage = function (e) {
        if (e.data && e.data.t === 'error') CV.setStatus(el.status, 'error', 'The synth engine did not start. ' + e.data.message, new Error('codec_load: ' + e.data.message));
      };
      out = ctx.createGain();
      out.gain.value = +el.vol.value;
      node.connect(out).connect(ctx.destination);
      if (ctx.state === 'suspended') ctx.resume();
      el.start.hidden = true;
      el.panel.hidden = false;
      CV.clearStatus(el.status);
    }).catch(function (e) {
      el.start.disabled = false;
      CV.setStatus(el.status, 'error', 'The synth did not start. ' + (e.message || e), e);
    });
  }

  el.start.addEventListener('click', startLive);
  el.vol.addEventListener('input', function () { if (out) out.gain.value = +el.vol.value; });
  el.voice.addEventListener('change', function () { post({ t: 'voice', data: currentVoice().data }); });
  el.stop.addEventListener('click', panic);

  // ---- the on-screen keys --------------------------------------------------

  var WHITE = [0, 2, 4, 5, 7, 9, 11], BLACK = { 0: 1, 1: 3, 3: 6, 4: 8, 5: 10 }, NAMES = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];

  function buildKeys() {
    el.keys.innerHTML = '';
    // Three octaves on a phone are keys too thin for a finger.
    var base = (octave + 1) * 12, octs = global.innerWidth < 600 ? 2 : 3, w = 100 / (octs * 7 + 1);
    for (var o = 0; o <= octs; o++) {
      for (var i = 0; i < 7; i++) {
        if (o === octs && i > 0) break;
        var k = document.createElement('div');
        k.className = 'dx-key';
        k.dataset.n = base + o * 12 + WHITE[i];
        k.style.left = ((o * 7 + i) * w) + '%';
        k.style.width = w + '%';
        if (i === 0) k.textContent = NAMES[i] + (octave + o);
        el.keys.appendChild(k);
        if (BLACK[i] != null && o < octs) {
          var b = document.createElement('div');
          b.className = 'dx-key dx-black';
          b.dataset.n = base + o * 12 + BLACK[i];
          b.style.left = ((o * 7 + i + 0.68) * w) + '%';
          b.style.width = (w * 0.64) + '%';
          el.keys.appendChild(b);
        }
      }
    }
    el.oct.textContent = 'C' + octave + ' to C' + (octave + octs);
  }

  // One pointer, one note; sliding across the keys moves the note with it.
  var pointers = {};
  function keyAt(e) {
    var t = document.elementFromPoint(e.clientX, e.clientY);
    return t && t.classList && t.classList.contains('dx-key') ? +t.dataset.n : null;
  }
  el.keys.addEventListener('pointerdown', function (e) {
    e.preventDefault();
    var n = keyAt(e);
    if (n == null) return;
    try { el.keys.setPointerCapture(e.pointerId); } catch (x) {}
    pointers[e.pointerId] = n;
    noteOn(n, 0.8);
  });
  el.keys.addEventListener('pointermove', function (e) {
    if (!(e.pointerId in pointers)) return;
    var n = keyAt(e), was = pointers[e.pointerId];
    if (n === was || n == null) return;
    noteOff(was);
    pointers[e.pointerId] = n;
    noteOn(n, 0.8);
  });
  function up(e) {
    if (!(e.pointerId in pointers)) return;
    noteOff(pointers[e.pointerId]);
    delete pointers[e.pointerId];
  }
  el.keys.addEventListener('pointerup', up);
  el.keys.addEventListener('pointercancel', up);

  $('#dxDown').addEventListener('click', function () { if (octave > 0) { panic(); octave--; buildKeys(); } });
  $('#dxUp').addEventListener('click', function () { if (octave < 6) { panic(); octave++; buildKeys(); } });

  // ---- the computer keyboard: the two rows a tracker uses ------------------

  var ROW = { KeyA: 0, KeyW: 1, KeyS: 2, KeyE: 3, KeyD: 4, KeyF: 5, KeyT: 6, KeyG: 7, KeyY: 8, KeyH: 9, KeyU: 10, KeyJ: 11, KeyK: 12, KeyO: 13, KeyL: 14, KeyP: 15, Semicolon: 16 };
  function typing(e) { var t = e.target; return t && (/^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName) || t.isContentEditable); }
  document.addEventListener('keydown', function (e) {
    if (!node || e.repeat || e.metaKey || e.ctrlKey || e.altKey || typing(e)) return;
    if (e.code === 'KeyZ') { $('#dxDown').click(); return; }
    if (e.code === 'KeyX') { $('#dxUp').click(); return; }
    if (e.code in ROW) { e.preventDefault(); noteOn((octave + 2) * 12 + ROW[e.code], 0.8); }
  });
  document.addEventListener('keyup', function (e) {
    if (e.code in ROW) {
      // The octave may have moved while the key was down: release whatever
      // this key could have started.
      for (var o = 0; o <= 8; o++) noteOff((o + 1) * 12 + ROW[e.code]);
    }
  });
  global.addEventListener('blur', panic);

  // ---- Web MIDI ------------------------------------------------------------

  function onMidi(e) {
    var d = e.data, s = d[0] & 0xf0;
    if (s === 0x90 && d[2] > 0) noteOn(d[1], d[2] / 127);
    else if (s === 0x80 || (s === 0x90 && d[2] === 0)) noteOff(d[1]);
    else if (s === 0xe0) post({ t: 'bend', v: (((d[2] << 7) | d[1]) - 8192) / 8192 });
    else if (s === 0xb0 && d[1] === 1) post({ t: 'mod', v: d[2] / 127 });
    else if (s === 0xb0 && d[1] === 64) post({ t: 'sus', v: d[2] >= 64 });
  }
  el.midiBtn.addEventListener('click', function () {
    if (!navigator.requestMIDIAccess) {
      el.midiNote.textContent = 'This browser has no Web MIDI (Safari does not). Chrome, Edge and Firefox do.';
      return;
    }
    navigator.requestMIDIAccess().then(function (access) {
      function bind() {
        var names = [];
        access.inputs.forEach(function (inp) { inp.onmidimessage = onMidi; names.push(inp.name); });
        el.midiNote.textContent = names.length ? 'Listening to ' + names.join(', ') + '.' : 'No MIDI keyboard found. Plug one in and it will be picked up.';
      }
      access.onstatechange = bind;
      bind();
    }, function () {
      el.midiNote.textContent = 'The browser refused access to MIDI devices.';
    });
  });

  // ---- files: .syx banks and .mid songs ------------------------------------

  function addBank(file, bytes) {
    var list = D.parseSyx(bytes), first = voices.length, label = file.name.replace(/\.[^.]+$/, '');
    list.forEach(function (v) { voices.push({ name: v.name, data: v.data, from: label }); });
    fillVoices(first);
    post({ t: 'voice', data: currentVoice().data });
    return list.length;
  }

  function setSong(file, bytes) {
    var m = MR.parse(bytes);
    var parts = m.parts.filter(function (p) { return p.notes.length; });
    if (!parts.length) throw new Error('That MIDI file has no notes in it.');
    song = { parts: parts, duration: m.duration };
    songFile = file.name.replace(/\.[^.]+$/, '');
    el.part.innerHTML = '';
    var all = document.createElement('option');
    all.value = 'all';
    all.textContent = 'Every part except drums (' + parts.filter(function (p) { return !p.drums; }).reduce(function (a, p) { return a + p.notes.length; }, 0) + ' notes)';
    el.part.appendChild(all);
    parts.forEach(function (p, i) {
      var o = document.createElement('option');
      o.value = i;
      o.textContent = (p.name || 'Channel ' + p.channel) + (p.drums ? ' (drums)' : '') + ': ' + p.notes.length + ' notes';
      el.part.appendChild(o);
    });
    el.songName.textContent = file.name + ', ' + Math.floor(m.duration / 60) + ':' + ('0' + Math.round(m.duration % 60)).slice(-2);
    el.song.hidden = false;
  }

  CV.bindDropzone(el.dropzone, el.fileInput, function (files) {
    if (!files.length) return;
    CV.clearStatus(el.status);
    var msgs = [];
    files.reduce(function (chain, f) {
      return chain.then(function () { return f.arrayBuffer(); }).then(function (ab) {
        var bytes = new Uint8Array(ab);
        if (/\.syx$/i.test(f.name)) msgs.push(addBank(f, bytes) + ' voices from ' + f.name + ' are in the voice list');
        else { setSong(f, bytes); msgs.push(f.name + ' is ready to render below'); }
      });
    }, Promise.resolve()).then(function () {
      CV.setStatus(el.status, 'success', msgs.join('; ') + '.');
    }, function (e) {
      CV.setStatus(el.status, 'error', e.message || String(e), e);
    });
  }, ['.syx', '.mid', '.midi']);

  function songNotes() {
    var parts = el.part.value === 'all' ? song.parts.filter(function (p) { return !p.drums; }) : [song.parts[+el.part.value]];
    // With only a drum part in the file, "all" would be empty.
    if (!parts.length) parts = song.parts;
    var notes = [];
    parts.forEach(function (p) {
      p.notes.forEach(function (n) { notes.push([n.midi, n.start, n.duration, n.velocity > 1 ? n.velocity / 127 : n.velocity]); });
    });
    return notes;
  }

  el.render.addEventListener('click', function () {
    if (!song) return;
    el.render.disabled = true;
    CV.setStatus(el.status, 'info', 'Rendering ' + songFile + ' through ' + currentVoice().name.trim() + '…');
    var fmt = el.format.value, rate = 48000;
    fetchWasm().then(function (bytes) {
      // A turn of the event loop, so the status line paints before the
      // render holds the thread (a five-minute song takes a few seconds).
      return new Promise(function (r) { setTimeout(r, 30); }).then(function () {
        var x = D.renderNotes(bytes, currentVoice().data, songNotes(), { sampleRate: rate, tail: 3 });
        var peak = 0, i;
        for (i = 0; i < x.length; i++) { var a = x[i] < 0 ? -x[i] : x[i]; if (a > peak) peak = a; }
        if (!peak) throw new Error('Those notes made no sound with this voice.');
        var top = Math.pow(10, -1 / 20), g = top / peak;
        for (i = 0; i < x.length; i++) x[i] *= g;
        var buf = new AudioBuffer({ length: x.length, sampleRate: rate, numberOfChannels: 1 });
        buf.copyToChannel(x, 0);
        return A.encode(buf, fmt, {}).then(function (blob) {
          var name = songFile + '-' + currentVoice().name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '.' + A.extFor(fmt);
          CV.downloadBlob(blob, name);
          CV.setStatus(el.status, 'success', 'Saved ' + name + ' (' + (x.length / rate).toFixed(1) + ' s, levelled to peak at -1 dBFS).');
        });
      });
    }).catch(function (e) {
      CV.setStatus(el.status, 'error', 'Could not render that. ' + (e.message || e), e);
    }).then(function () { el.render.disabled = false; });
  });

  fillVoices(1);
  buildKeys();

  // For the check: what is live, never used by the page itself.
  global.__dx = { state: function () { return { ctx: ctx && ctx.state, node: !!node, voices: voices.length, voice: currentVoice().name, held: Object.keys(held).length, song: song && song.parts.length }; }, node: function () { return node; }, ctx: function () { return ctx; } };
})(window);
