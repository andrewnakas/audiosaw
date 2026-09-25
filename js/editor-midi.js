/*
 * MIDI in /audio-editor: the clip menu's MIDI entries, .mid import, and the
 * note editor.
 *
 * A MIDI clip is an ordinary clip whose source holds notes instead of
 * samples (see "midi" in editor-model.js), played through the track's
 * instrument (editor-synth.js) by the engine. So everything that works on
 * clips by time (split, trim, move, ripple, takes, loop, export, bouncing a
 * range) already works on it. What is here is the part that needs the
 * notes themselves:
 *
 *   - importing a .mid file, one track per part, drums on a drum kit
 *   - editing notes in the piano roll /audio-to-midi uses; saving writes a
 *     new source, one undoable edit, like an effect
 *   - choosing a track's instrument
 *   - Download .mid, written by midi-write.js
 *   - Bounce to audio, for the tools that need samples (effects, sending to
 *     a tool page, chord and key detection)
 *   - Convert to MIDI on an audio clip: the pitch tracker behind
 *     /audio-to-midi, onto a new MIDI track under it
 *   - a new, empty MIDI clip to draw into
 */
(function (global) {
  'use strict';

  var M = global.ASEditModel, SY = global.ASEditSynth;
  var X = null;   // what editor-ui.js hands over in init()

  function init(ctx) { X = ctx; }

  function isMidiClip(clipId) {
    var f = M.findClip(X.S.project, clipId);
    return !!(f && M.isMidi(X.S.project, f.clip.sourceId));
  }
  function anyMidi(ids) { return ids.some(isMidiClip); }

  function instLabel(id) {
    var d = SY.INSTRUMENTS.filter(function (x) { return x.id === id; })[0];
    return d ? d.label : SY.INSTRUMENTS[0].label;
  }
  function instOf(track, src) { return track.inst || (src && src.drums ? 'drums' : 'keys'); }

  // General MIDI program families to our instruments, near enough.
  function instForProgram(prog, drums) {
    if (drums) return 'drums';
    if (prog == null) return 'keys';
    if (prog < 8) return 'keys';
    if (prog < 16) return 'keys';
    if (prog < 24) return 'organ';
    if (prog < 32) return 'pluck';
    if (prog < 40) return 'bass';
    if (prog < 56) return 'pad';
    if (prog < 80) return 'lead';
    if (prog < 88) return 'lead';
    if (prog < 104) return 'pad';
    return 'keys';
  }

  /* --------------------------------------------------------------- import */

  function isMidiFile(f) { return /\.(mid|midi|smf|kar)$/i.test(f.name); }

  // place: { t } where the file starts. Returns the new clip ids.
  function importFile(file, place) {
    return file.arrayBuffer().then(function (ab) {
      var r = global.ASMidiRead.parse(ab);
      if (!r.parts.length) throw new Error('it has no notes');
      var p = X.S.project, empty = !p.tracks.some(function (t) { return t.clips.length; });
      // An empty project takes the file's tempo and time signature, so the
      // bars line up with the music.
      if (empty) {
        M.setBpm(p, Math.round(r.bpm * 100) / 100);
        if (r.sig && r.sig[0] >= 2 && r.sig[0] <= 12) M.setSig(p, r.sig[0], r.sig[1]);
        if (!p.name || p.name === 'Untitled project') p.name = file.name.replace(/\.[^.]+$/, '');
      }
      var start = Math.max(0, (place && place.t) || 0), ids = [];
      // A lone empty track is used rather than left above the new ones.
      var reuse = p.tracks.length === 1 && !p.tracks[0].clips.length ? p.tracks[0].id : null;
      r.parts.forEach(function (part) {
        var name = part.name.replace(/^\s+|\s+$/g, '') || 'MIDI';
        var sid = M.addSource(p, { kind: 'midi', name: name, notes: part.notes, duration: r.duration, drums: part.drums });
        var tid = reuse || M.addTrack(p, { name: name });
        if (reuse) { M.setTrack(p, tid, { name: name }); reuse = null; }
        M.setTrack(p, tid, { inst: instForProgram(part.program, part.drums) });
        ids.push(M.addClip(p, tid, { sourceId: sid, start: start, name: name }));
      });
      return { ids: ids, parts: r.parts.length, notes: r.parts.reduce(function (a, x) { return a + x.notes.length; }, 0) };
    });
  }

  /* ---------------------------------------------------------- note editor */

  // The piano roll works in clip time (0 = the clip's start); on save the
  // edited notes go back at the clip's offset in a new source, with any
  // notes outside the clip's window left as they were.
  function editNotes(clipId) {
    var S = X.S, f = M.findClip(S.project, clipId);
    if (!f) return;
    var c = f.clip, src = S.project.sources[c.sourceId];
    var a = c.offset, b = c.offset + c.duration;
    var inside = M.notesOf(src).filter(function (n) { return n.start >= a - 1e-9 && n.start < b; })
      .map(function (n) { return { midi: n.midi, start: n.start - a, duration: Math.min(n.duration, b - n.start), velocity: n.velocity }; });
    X.openSheet('Notes: ' + c.name,
      '<p class="ed-sheet-note">Drag a note to move it, drag its end to change its length, double-click to add or delete. The grid is the project tempo, ' + S.project.bpm + ' BPM.</p>' +
      '<canvas class="piano-roll ed-roll" tabindex="0" aria-label="Piano roll of this clip\'s notes"></canvas>' +
      '<div class="ed-sheet-actions">' +
      '<button type="button" class="ed-btn" data-v="play">Play</button>' +
      '<button type="button" class="ed-btn" data-v="quant">Snap to the grid</button>' +
      '<button type="button" class="ed-btn" data-v="undo">Undo</button>' +
      '<button type="button" class="ed-btn" data-close>Cancel</button>' +
      '<button type="button" class="ed-btn ed-btn-primary" data-v="save">Save notes</button></div>',
      function (v, btn) {
        if (v === 'play') { if (raf) stopPlay(); else startPlay(btn); return; }
        stopPlay();
        if (v === 'quant') roll.quantize();
        if (v === 'undo') roll.undo();
        if (v !== 'save') return;
        var edited = roll.notes().filter(function (n) { return n.duration > 0.005; });
        var keep = M.notesOf(src).filter(function (n) { return n.start < a - 1e-9 || n.start >= b; });
        var all = keep.concat(edited.map(function (n) { return { midi: n.midi, start: n.start + a, duration: n.duration, velocity: n.velocity }; }));
        X.closeSheet();
        X.edit(function (p) {
          var cur = M.findClip(p, clipId);
          if (!cur) return;
          var end = all.reduce(function (e, n) { return Math.max(e, n.start + n.duration); }, 0);
          var sid = M.addSource(p, { kind: 'midi', name: src.name, notes: all, duration: Math.max(src.duration, end), drums: src.drums });
          cur.clip.sourceId = sid;
        });
        X.status('success', 'Notes saved: ' + edited.length + ' in “' + c.name + '”. Undo puts the old ones back.');
      }, 'ed-sheet-wide ed-sheet-roll');
    var cv = document.querySelector('#edSheet .ed-roll');
    var roll = new global.ASPianoRoll(cv, { bpm: S.project.bpm, division: 4 });
    roll.setNotes(inside);

    // Play what is in the roll now, saved or not, on the track's instrument.
    var E = global.ASEditEngine, raf = 0, playBtn = null, sheet = document.getElementById('edSheet');
    function startPlay(btn) {
      var ns = roll.notes(), end = ns.reduce(function (e, n) { return Math.max(e, n.start + n.duration); }, 0);
      if (!ns.length) return;
      if (E.isPlaying()) E.stop();
      E.unlock();
      var t0 = E.previewNotes(ns, instOf(f.track, src));
      playBtn = btn; btn.textContent = 'Stop';
      (function tick() {
        if (sheet.hidden) { stopPlay(); return; }
        var t = E.now() - t0;
        if (t > end + 0.3) { stopPlay(); return; }
        roll.playhead = Math.max(0, t); roll.draw();
        raf = requestAnimationFrame(tick);
      })();
    }
    function stopPlay() {
      if (!raf && !playBtn) return;
      cancelAnimationFrame(raf); raf = 0;
      E.stopPreview();
      roll.playhead = null; roll.draw();
      if (playBtn) playBtn.textContent = 'Play';
      playBtn = null;
    }
  }

  /* ----------------------------------------------------------- instrument */

  function instrumentSheet(trackId) {
    var S = X.S, t = S.project.tracks[M.trackIndex(S.project, trackId)];
    if (!t) return;
    var cur = t.inst || null;
    X.openSheet('Instrument for ' + t.name, X.menuHtml(SY.INSTRUMENTS.map(function (d) {
      return { v: d.id, label: d.label + (cur === d.id ? '  ✓' : ''), hint: d.hint };
    })) + '<p class="ed-sheet-note">It plays the MIDI clips on this track. These are simple synth voices, not recorded instruments; for a real piano or guitar sound, bounce to audio and use your own, or export the .mid to a DAW.</p>', function (v) {
      X.closeSheet();
      X.edit(function (p) { M.setTrack(p, trackId, { inst: v }); });
      X.toast(instLabel(v));
    });
  }

  /* ------------------------------------------------------------- download */

  function downloadMid(clipId) {
    var S = X.S, f = M.findClip(S.project, clipId);
    if (!f) return;
    var notes = M.clipNotes(S.project, f.clip).map(function (n) { return { midi: n.midi, start: n.start - f.clip.start, duration: n.duration, velocity: n.velocity }; });
    var bytes = global.ASMidi.build(notes, { bpm: S.project.bpm, trackName: f.clip.name });
    global.CV.downloadBlob(new Blob([bytes], { type: 'audio/midi' }), f.clip.name.replace(/[\\/:*?"<>|]+/g, '-') + '.mid');
    X.status('success', 'Downloaded ' + notes.length + ' notes as a .mid at ' + S.project.bpm + ' BPM.');
  }

  /* --------------------------------------------------------------- bounce */

  // The clip through its instrument alone: no track effects, level or pan,
  // since those stay live on the track, and without its own gain and fades,
  // which stay on the clip. The result replaces the clip's source, so undo
  // puts the MIDI back.
  function bounce(clipId) {
    var S = X.S, f = M.findClip(S.project, clipId);
    if (!f || X.isBusy()) return Promise.resolve();
    var p1 = M.copy(S.project), c = f.clip;
    p1.tracks = p1.tracks.filter(function (t) { return t.id === f.track.id; });
    var t = p1.tracks[0];
    t.fx = []; t.sends = {}; t.auto = {}; t.volDb = 0; t.pan = 0; t.mute = false; t.solo = false; t.takes = [];
    t.inst = instOf(f.track, S.project.sources[c.sourceId]);
    t.clips = t.clips.filter(function (x) { return x.id === clipId; }).map(function (x) { return Object.assign({}, x, { gainDb: 0, fadeIn: 0, fadeOut: 0 }); });
    p1.master.fx = []; p1.master.auto = {}; p1.master.volDb = 0; p1.buses = [];
    X.setBusy(true);
    X.status('info', 'Bouncing “' + c.name + '” to audio…');
    // At the project's own rate, so the bounce sits with the audio around it
    // without a conversion.
    return global.ASEditEngine.render(p1, c.start, M.clipEnd(c), { sampleRate: global.ASEditEngine.projectRate(S.project), channels: 2, noMaster: true }).then(function (res) {
      X.edit(function (p) {
        var sid = M.addSource(p, { name: c.name + ' (audio)', duration: res.buffer.duration, channels: 2, sampleRate: res.buffer.sampleRate, kind: 'derived' });
        X.buffers.set(sid, res.buffer);
        global.ASEditView.buildPeaks(sid, res.buffer);
        M.replaceClipAudio(p, clipId, sid, res.buffer.duration, false);
      });
      X.status('success', 'Bounced “' + c.name + '” to audio with the ' + instLabel(t.inst) + '. Effects, tools and detection work on it now; undo brings the notes back.');
    }).catch(function (e) {
      X.status('error', 'Bounce failed: ' + ((e && e.message) || e));
    }).then(function () { X.setBusy(false); });
  }

  /* -------------------------------------------------------- audio to MIDI */

  // One voice or instrument at a time, as on /audio-to-midi: a full mix has
  // no single pitch to follow. The notes go on a new track under the clip,
  // lined up with it, so the two can be compared by ear.
  function convert(clipId) {
    var S = X.S, f = M.findClip(S.project, clipId), P = global.ASPitch;
    if (!f || !P || X.isBusy()) return;
    var c = f.clip, buf = X.buffers.get(c.sourceId);
    if (!buf) return;
    X.setBusy(true);
    X.status('info', 'Listening for notes in “' + c.name + '”…');
    setTimeout(function () {
      try {
        var sr = buf.sampleRate, i0 = Math.floor(c.offset * sr), n = Math.max(0, Math.min(buf.length - i0, Math.round(c.duration * sr)));
        var mono = new Float32Array(n);
        for (var ch = 0; ch < buf.numberOfChannels; ch++) {
          var d = buf.getChannelData(ch);
          for (var i = 0; i < n; i++) mono[i] += d[i0 + i] / buf.numberOfChannels;
        }
        var notes = P.segment(P.track(mono, sr, {}), {});
        if (!notes.length) { X.status('warn', 'No clear notes in “' + c.name + '”. This follows one voice or instrument at a time; a full mix has no single pitch to follow.'); return; }
        var cid = null;
        X.edit(function (p) {
          var ti = M.trackIndex(p, f.track.id);
          var tid = M.addTrack(p, { index: ti + 1, name: c.name + ' (MIDI)' });
          M.setTrack(p, tid, { inst: 'lead' });
          var sid = M.addSource(p, { kind: 'midi', name: c.name + ' (MIDI)', notes: notes, duration: c.duration });
          cid = M.addClip(p, tid, { sourceId: sid, start: c.start, duration: c.duration, name: c.name + ' (MIDI)' });
        });
        X.select(cid);
        X.status('success', notes.length + ' notes from “' + c.name + '” on a new MIDI track under it. Mute one to compare; right-click the new clip to edit the notes or change the instrument.');
      } catch (e) {
        X.status('error', 'Could not convert “' + c.name + '”: ' + ((e && e.message) || e));
      } finally { X.setBusy(false); }
    }, 30);
  }

  /* ------------------------------------------------------------- new clip */

  // An empty clip of four bars at the playhead, on the selected track when it
  // has room there, otherwise on a new track; the note editor opens on it.
  function newClip() {
    var S = X.S, p = S.project, len = 4 * M.barSec(p), t0 = Math.max(0, S.playhead), cid = null;
    X.edit(function (pp) {
      var tid = S.selTrack && M.trackIndex(pp, S.selTrack) >= 0 ? S.selTrack : null;
      var tr = tid ? pp.tracks[M.trackIndex(pp, tid)] : null;
      if (!tr || tr.clips.some(function (x) { return x.start < t0 + len && M.clipEnd(x) > t0; })) {
        tid = M.addTrack(pp, { name: 'MIDI ' + (pp.tracks.filter(function (t) { return /^MIDI/.test(t.name); }).length + 1) });
        M.setTrack(pp, tid, { inst: 'keys' });
      }
      var sid = M.addSource(pp, { kind: 'midi', name: 'MIDI clip', notes: [], duration: len });
      cid = M.addClip(pp, tid, { sourceId: sid, start: t0, duration: len, name: 'MIDI clip' });
    });
    X.select(cid);
    editNotes(cid);
  }

  global.ASEditMidi = {
    init: init, isMidiClip: isMidiClip, anyMidi: anyMidi, isMidiFile: isMidiFile, importFile: importFile,
    editNotes: editNotes, instrumentSheet: instrumentSheet, instLabel: instLabel, instOf: instOf,
    downloadMid: downloadMid, bounce: bounce, convert: convert, newClip: newClip
  };
})(window);
