/*
 * ASEditSpeech — "Add speech…" in /audio-editor: type a line, pick one of
 * Kokoro's 41 voices, and the speech lands as a clip at the playhead.
 *
 * It drives the same tts-worker.js as /text-to-speech (ORT 1.22: fp32 on
 * WebGPU, q8 on the CPU), chunked by ASTTS.chunk with the same pauses, and
 * hands the result to the editor's own importFiles as a 16-bit WAV tagged as
 * synthetic speech. So decoding, autosave (the WAV is stored the way an
 * imported file is), undo and selection are the import path's, not new code.
 *
 * Placement: the selected track when it is empty for the length of the
 * speech at the playhead, otherwise a new track. It never carves into
 * existing audio, which importFiles' "at" placement would do.
 */
(function (global) {
  'use strict';

  var ASSET_V = (function () {
    var m = document.currentScript && /[?&]v=([^&]+)/.exec(document.currentScript.src);
    return m ? m[1] : '1';
  })();

  var X = null, worker = null, job = 0, pending = null, small = false;
  var SR = global.ASTTS ? global.ASTTS.SAMPLE_RATE : 24000;

  function ensureWorker() {
    if (worker) return worker;
    var force = /[?&]backend=(wasm|webgpu)\b/.exec(global.location.search);
    var backend = force ? force[1] : (small ? 'wasm' : '');
    worker = new Worker('/js/tts-worker.js?v=' + ASSET_V + (backend ? '&backend=' + backend : ''));
    worker.onmessage = function (e) {
      var m = e.data || {};
      if (!pending) return;
      if (m.type === 'status') pending.onStatus(m.detail || 'Loading the voice model…');
      else if (m.type === 'audio' && m.job === pending.job) {
        pending.parts[m.seq] = global.ASTTS.trimSilence(m.samples).slice();
        pending.got++;
        pending.onStatus('Speaking… ' + pending.got + ' of ' + pending.chunks.length);
        if (pending.got === pending.chunks.length) { var p = pending; pending = null; p.resolve(join(p)); }
      } else if (m.type === 'error' && (m.job == null || m.job === pending.job)) {
        var q = pending; pending = null; q.reject(new Error(m.message || 'The voice model failed.'));
      }
    };
    worker.postMessage({ type: 'load' });
    return worker;
  }

  function join(p) {
    var n = 0;
    p.parts.forEach(function (x, i) { n += x.length + Math.round(p.chunks[i].pause * SR); });
    var out = new Float32Array(n), o = 0;
    p.parts.forEach(function (x, i) { out.set(x, o); o += x.length + Math.round(p.chunks[i].pause * SR); });
    // No trailing pause after the last sentence.
    return out.subarray(0, Math.max(0, n - Math.round(p.chunks[p.chunks.length - 1].pause * SR)));
  }

  // Text → Float32Array at 24 kHz, mono.
  function synth(text, voiceId, speed, onStatus) {
    var chunks = global.ASTTS.chunk(text);
    if (!chunks.length) return Promise.reject(new Error('Type something to say first.'));
    var v = global.ASTTS.voice(voiceId) || global.ASTTS.voice('af_heart');
    var w = ensureWorker();
    job++;
    return new Promise(function (resolve, reject) {
      pending = { job: job, chunks: chunks, parts: [], got: 0, resolve: resolve, reject: reject, onStatus: onStatus || function () {} };
      chunks.forEach(function (c, i) {
        w.postMessage({ type: 'synth', job: job, seq: i, text: c.text, lang: v.lang, mix: [{ id: v.id, w: 1 }], speed: speed || 1 });
      });
    });
  }

  function wavFile(samples, text, voiceId) {
    var AS = global.AudioSaw;
    var buf = AS.makeBuffer([samples], SR);
    return AS.encode(buf, 'wav16').then(function (blob) { return blob.arrayBuffer(); }).then(function (ab) {
      var v = global.ASTTS.voice(voiceId);
      var tagged = global.ASTTS.tagWav(new Uint8Array(ab), {
        title: text.trim().slice(0, 80),
        artist: 'AI voice: ' + (v ? v.name : voiceId),
        software: 'AudioSaw audio editor (Kokoro-82M)',
        comment: 'Synthetic speech generated with Kokoro-82M at audiosaw.com/audio-editor'
      });
      var words = text.trim().split(/\s+/).slice(0, 5).join(' ').replace(/[\\/:*?"<>|]+/g, '');
      return new File([tagged], 'Speech - ' + (words || 'line') + '.wav', { type: 'audio/wav' });
    });
  }

  function place(seconds) {
    var S = X.S, p = S.project, M = global.ASEditModel, t0 = Math.max(0, S.playhead || 0);
    var ti = S.selTrack ? M.trackIndex(p, S.selTrack) : -1;
    var tr = ti >= 0 ? p.tracks[ti] : null;
    var free = tr && !tr.clips.some(function (c) { return c.start < t0 + seconds && M.clipEnd(c) > t0; });
    // importFiles adds tracks until the index exists, so a new last track is
    // just "one past the end".
    return { mode: 'at', ti: free ? ti : p.tracks.length, t: t0 };
  }

  var last = { text: '', voice: 'af_heart', speed: 1 };

  function open() {
    var A = global.ASTTS;
    var html = '<div class="ed-form ed-speech">' +
      '<label class="ed-speech-text">What to say <textarea data-k="text" rows="4" maxlength="5000" placeholder="Welcome back. In this episode…">' + X.esc(last.text) + '</textarea></label>' +
      '<label>Voice <select data-k="voice"></select></label>' +
      '<label>Speed <output data-o="speed">' + last.speed.toFixed(2) + '×</output><input type="range" min="0.6" max="1.6" step="0.05" value="' + last.speed + '" data-k="speed"></label>' +
      '<label class="ed-check"><input type="checkbox" data-k="small"' + (small ? ' checked' : '') + '> smaller model (92 MB, CPU) instead of the fast GPU one (326 MB)</label>' +
      '<p class="ed-note" data-o="note">The voice model downloads once and is cached. The clip goes at the playhead, on the selected track if it is free there, else on a new track. It is labelled as synthetic speech in its own tags.</p>' +
      '</div>' + X.menuHtml([{ v: 'go', label: 'Add the speech', hint: 'at the playhead' }]);
    X.openSheet('Add speech', html, function (v, btn) {
      if (v !== 'go' || btn.disabled) return;
      run(btn);
    }, 'ed-sheet-speech');
    var body = document.querySelector('.ed-speech');
    var sel = body.querySelector('[data-k=voice]');
    A.fillVoiceSelect(sel, false);
    sel.value = last.voice;
    var sp = body.querySelector('[data-k=speed]');
    sp.addEventListener('input', function () { body.querySelector('[data-o=speed]').textContent = (+sp.value).toFixed(2) + '×'; });
    body.querySelector('[data-k=small]').addEventListener('change', function (e) {
      if (small !== e.target.checked) { small = e.target.checked; if (worker && !pending) { worker.terminate(); worker = null; } }
    });
    var ta = body.querySelector('textarea');
    if (ta && !X.isTouchUI()) ta.focus();
  }

  function run(btn) {
    var body = document.querySelector('.ed-speech');
    if (!body) return;
    var text = body.querySelector('textarea').value;
    last = { text: text, voice: body.querySelector('[data-k=voice]').value, speed: +body.querySelector('[data-k=speed]').value || 1 };
    if (!text.trim()) { body.querySelector('[data-o=note]').textContent = 'Type something to say first.'; return; }
    if (X.isBusy()) return;
    btn.disabled = true;
    var note = body.querySelector('[data-o=note]');
    function say(m) { if (note && note.isConnected) note.textContent = m; X.status('info', m); }
    say('Loading the voice model…');
    synth(text, last.voice, last.speed, say).then(function (samples) {
      if (!samples.length) throw new Error('The voice came back silent.');
      return wavFile(samples, text, last.voice).then(function (file) {
        X.closeSheet();
        last.text = '';
        return X.importFiles([file], place(samples.length / SR));
      });
    }).then(function () {
      X.toast('Speech added — undo removes it');
    }).catch(function (e) {
      btn.disabled = false;
      X.status('error', 'Could not make the speech. ' + ((e && e.message) || e), e);
      if (note && note.isConnected) note.textContent = 'Could not make the speech: ' + ((e && e.message) || e);
    });
  }

  global.ASEditSpeech = {
    init: function (ctx) { X = ctx; },
    open: open,
    synth: synth,
    _place: place,
    _state: function () { return X && X.S; }   // tools/check-editor-speech.js
  };
})(window);
