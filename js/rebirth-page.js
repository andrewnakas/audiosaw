/*
 * /rebirth-player page controller. A ReBirth RB-338 song (.rbs) is rendered
 * offline by js/rebirth-worker.js over vendor/openrb/2026-11-13/openrb.wasm:
 * the engine of OpenRB-338 (GPL-3.0-only), whose output matches the original
 * program's sample for sample.
 *
 * The drum sounds are not ours to hand out. ReBirth's 46 drum samples are
 * Propellerhead's, and neither they nor the key that mods are scrambled
 * with are in this site's files. The TB-303s and the effects are pure
 * synthesis and always play. For the drums the visitor drops the kit
 * themselves: a .rbm (the standard kit or a mod) with its 2,047-byte key
 * file, or a clear .orbkit. What they drop stays in this tab's memory; it
 * is not stored or sent.
 *
 * Which file is which goes by name and size: 2,047 bytes is the key; a kit
 * file with "standard" in its name is the standard kit; any other kit file
 * is the mod for the current song.
 *
 * The engine's output is 16-bit at 44.1 kHz, so the 16-bit WAV is the
 * original's own export bit for bit and the default.
 */
(function (global) {
  'use strict';
  var CV = global.CV, A = global.AudioSaw;
  if (!CV || !A) { console.error('[rebirth] the /js/* includes must come before rebirth-page.js'); return; }
  var $ = CV.$;
  var Q = ((document.currentScript && document.currentScript.src) || '').replace(/^[^?]*/, '');
  var el = {
    dropzone: $('#dropzone'), fileInput: $('#fileInput'), status: $('#status'), progress: $('#progressBar'), wrap: $('#progressWrap'),
    view: $('#rbView'), title: $('#rbTitle'), facts: $('#rbFacts'), text: $('#rbText'), notes: $('#rbNotes'), audio: $('#rbAudio'),
    range: $('#rbRange'), format: $('#rbFormat'), save: $('#convertBtn'), kitState: $('#rbKitState')
  };
  if (!el.dropzone || !el.view) return;
  var KEY_BYTES = 2047;
  var worker = null, job = 0, waiting = {};
  var song = null, songName = '', kit = null, kitName = '', mod = null, modName = '', key = null, out = null;

  function startWorker() {
    if (worker) return worker;
    worker = new Worker('/js/rebirth-worker.js' + Q);
    worker.onmessage = function (e) {
      var m = e.data, w = waiting[m.id];
      if (!w) return;
      if (m.progress != null) { if (m.id === job) CV.setProgress(el.progress, Math.round(m.progress * 100)); return; }
      delete waiting[m.id];
      if (m.error) w.reject(new Error(m.error)); else w.resolve(m.result);
    };
    worker.onerror = function (e) {
      Object.keys(waiting).forEach(function (id) { waiting[id].reject(new Error('The player stopped. ' + (e.message || ''))); });
      waiting = {};
      worker = null;
    };
    return worker;
  }

  function mmss(s) { return Math.floor(s / 60) + ':' + ('0' + Math.floor(s % 60)).slice(-2); }

  function kitLine() {
    var parts = [];
    parts.push(kit ? 'Standard kit: ' + kitName : 'Standard kit: none yet');
    if (mod) parts.push('Mod: ' + modName);
    parts.push(key ? 'Key: loaded' : 'Key: none');
    el.kitState.textContent = parts.join(' · ');
  }

  function render() {
    var id = ++job;
    return new Promise(function (resolve, reject) {
      waiting[id] = { resolve: resolve, reject: reject };
      // Copies go to the worker; the originals are kept for the next render.
      startWorker().postMessage({
        id: id, song: song.slice(0), kit: kit && kit.slice(0), mod: mod && mod.slice(0), key: key && key.slice(0),
        range: el.range.value === 'song' ? 'song' : null, maxSeconds: 1200
      });
    }).then(function (r) { return id === job ? r : null; });
  }

  function show(r) {
    var buf = new AudioBuffer({ length: r.frames, sampleRate: r.sampleRate, numberOfChannels: 2 });
    buf.copyToChannel(new Float32Array(r.left), 0);
    buf.copyToChannel(new Float32Array(r.right), 1);
    out = { buffer: buf, duration: r.duration };
    var i = r.info, notes = [];
    el.title.textContent = (i.title || '').trim() || songName;
    el.facts.textContent = i.format + ' · ' + (Math.round(i.bpm * 10) / 10) + ' BPM · bars ' + (i.range[0] + 1) + ' to ' + i.range[1] +
      (i.rangeIsLoop ? ' (the song\'s loop)' : ' (to the last note)') + ' · ' + mmss(r.duration);
    var text = [i.text, i.webPage].filter(function (t) { return t && t.trim(); }).join('\n');
    el.text.textContent = text;
    el.text.parentNode.hidden = !text;
    if (r.drumsSilent) notes.push('The drum machines are silent: this song has one switched on, and no drum kit has been dropped. The bass lines and effects are complete. Drop the standard kit file (and its key) to hear the drums.');
    if (r.modMissing) notes.push('This song was made with the mod "' + (i.modName || '').trim() + '"' + (r.kitUsed ? ', which is not loaded, so the standard kit is playing its drums.' : ', which is not loaded.'));
    if (r.modMismatch) notes.push('The mod you dropped is not the one this song names ("' + (i.modName || '').trim() + '").');
    if (r.modIncomplete) notes.push('The mod leaves some drums to the standard kit, which is not loaded, so those are silent.');
    if (r.truncated) notes.push('Stopped at the 20-minute limit.');
    el.notes.textContent = notes.join(' ');
    el.notes.hidden = !notes.length;
    el.view.hidden = false;
    return A.encode(buf, 'wav16', { quiet: true }).then(function (wav) {
      if (el.audio.src) URL.revokeObjectURL(el.audio.src);
      el.audio.src = URL.createObjectURL(wav);
      CV.setStatus(el.status, 'success', 'Rendered ' + mmss(r.duration) + (r.drumsSilent ? ' without drums' : '') + '. Press play, or save it.');
    });
  }

  function run() {
    if (!song) return Promise.resolve();
    el.save.disabled = true;
    CV.setStatus(el.status, 'info', 'Rendering ' + songName + '…');
    el.wrap.style.display = ''; CV.setProgress(el.progress, 0);
    return render().then(function (r) {
      if (r) return show(r);
    }).catch(function (e) {
      out = null;
      el.view.hidden = true;
      CV.setStatus(el.status, 'error', e.message || String(e), new Error('bad_file: ' + (e.message || e)));
    }).then(function () { el.save.disabled = !out; el.wrap.style.display = 'none'; });
  }

  CV.bindDropzone(el.dropzone, el.fileInput, function (files) {
    if (!files.length) return;
    var gotSong = false, said = [];
    Promise.all(files.map(function (f) { return f.arrayBuffer().then(function (ab) { return { f: f, ab: ab }; }); })).then(function (list) {
      list.forEach(function (x) {
        var n = x.f.name;
        if (/\.rbs$/i.test(n)) {
          // A new song leaves the last song's mod behind; the kit and key stay.
          if (!gotSong) { song = x.ab; songName = n; mod = null; modName = ''; gotSong = true; }
        } else if (x.ab.byteLength === KEY_BYTES) { key = x.ab; said.push('the key'); }
        else if (/\.(rbm|orbkit)$/i.test(n)) {
          if (/standard/i.test(n)) { kit = x.ab; kitName = n; said.push('the standard kit'); }
          else { mod = x.ab; modName = n; said.push('the mod ' + n); }
        }
      });
      // A mod dropped with its song must survive the reset above.
      if (gotSong) list.forEach(function (x) {
        if (/\.(rbm|orbkit)$/i.test(x.f.name) && !/standard/i.test(x.f.name)) { mod = x.ab; modName = x.f.name; }
      });
      kitLine();
      if (song) return run();
      CV.setStatus(el.status, 'info', 'Loaded ' + said.join(' and ') + '. Now drop a song (.rbs).');
    }).catch(function (e) {
      CV.setStatus(el.status, 'error', 'The browser could not read that file. ' + (e.message || e), e);
    });
  }, ['.rbs', '.rbm', '.orbkit', '.bin']);

  el.range.addEventListener('change', run);

  el.save.addEventListener('click', function () {
    if (!out) return;
    var fmt = el.format.value;
    el.save.disabled = true;
    CV.setStatus(el.status, 'info', 'Writing the file…');
    A.encode(out.buffer, fmt, {}).then(function (blob) {
      var name = songName.replace(/\.[^.]+$/, '') + '.' + A.extFor(fmt);
      CV.downloadBlob(blob, name);
      CV.setStatus(el.status, 'success', 'Saved ' + name + ' (' + mmss(out.duration) + ', ' + (blob.size / 1048576).toFixed(1) + ' MB).');
    }).catch(function (e) {
      CV.setStatus(el.status, 'error', 'Could not write that file. ' + (e.message || e), e);
    }).then(function () { el.save.disabled = false; });
  });

  kitLine();

  // For the check: the last render's facts, never used by the page itself.
  global.__rb = { state: function () { return { out: out && { duration: out.duration, rate: out.buffer.sampleRate }, kit: !!kit, key: !!key, mod: !!mod, notes: el.notes.textContent, facts: el.facts.textContent, title: el.title.textContent }; } };
})(window);
