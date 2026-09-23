/*
 * Keeping an editor session: autosave to IndexedDB, and .audiosaw project files.
 *
 * Its own database, `audiosaw-editor`, deliberately not the `audiosaw` one that
 * flow.js and sw.js share for the handoff. Those two must agree on a version
 * number or one of them throws VersionError (see CLAUDE.md), and a third writer
 * bumping it for its own stores would be exactly that bug.
 *
 * What is stored per source depends on where it came from. An imported file is
 * kept as the original file — an hour of MP3 is 60 MB as a file and well over a
 * gigabyte as decoded float samples — and decoded again on restore. A recording
 * or an effect's output has no file, so its samples are kept as Float32 arrays.
 *
 * A project file is a plain zip (written by AudioSaw.zipBlobs, stored rather
 * than deflated) holding project.json and one file per source, so it can be
 * opened on another machine, or unpacked by hand if this site ever went away.
 */
(function (global) {
  'use strict';

  var DB = 'audiosaw-editor', VERSION = 1;
  var dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise(function (res, rej) {
      if (!global.indexedDB) return rej(new Error('No IndexedDB'));
      var r = indexedDB.open(DB, VERSION);
      r.onupgradeneeded = function () {
        var db = r.result;
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
        if (!db.objectStoreNames.contains('sources')) db.createObjectStore('sources');
      };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
    dbp.catch(function () { dbp = null; });
    return dbp;
  }

  function tx(store, mode, fn) {
    return open().then(function (db) {
      return new Promise(function (res, rej) {
        var t = db.transaction(store, mode);
        var out = fn(t.objectStore(store));
        t.oncomplete = function () { res(out && out.result !== undefined ? out.result : out); };
        t.onerror = function () { rej(t.error); };
        t.onabort = function () { rej(t.error || new Error('aborted')); };
      });
    });
  }

  // The editor swaps in its own decoder, which falls back to ffmpeg for
  // formats the browser cannot open (video containers, WMA, AC3).
  function decode(file) {
    return (global.ASEditStore.decode || global.AudioSaw.decodeToAudioBuffer)(file);
  }

  var stored = new Set();     // source ids known to be in the database

  // files: Map sourceId -> original File (for kind 'file')
  function save(project, buffers, files) {
    var M = global.ASEditModel;
    var used = M.usedSources(project);
    var slim = M.copy(project);
    Object.keys(slim.sources).forEach(function (k) { if (!used[k]) delete slim.sources[k]; });

    var todo = Object.keys(used).filter(function (id) { return !stored.has(id); });
    var chain = Promise.resolve();
    todo.forEach(function (id) {
      chain = chain.then(function () {
        var meta = project.sources[id];
        var rec = { id: id, kind: meta.kind };
        var file = files.get(id);
        if (file) {
          rec.file = file;
        } else {
          var b = buffers.get(id);
          if (!b) return;
          rec.sr = b.sampleRate;
          rec.chans = [];
          for (var c = 0; c < b.numberOfChannels; c++) rec.chans.push(new Float32Array(b.getChannelData(c)));
        }
        return tx('sources', 'readwrite', function (s) { s.put(rec, id); }).then(function () { stored.add(id); });
      });
    });
    return chain.then(function () {
      return tx('meta', 'readwrite', function (s) {
        s.put(JSON.stringify(slim), 'project');
        s.put(Date.now(), 'savedAt');
      });
    }).then(function () {
      // Drop sources nothing references any more.
      return tx('sources', 'readonly', function (s) { return s.getAllKeys(); }).then(function (keys) {
        var gone = (keys || []).filter(function (k) { return !used[k]; });
        if (!gone.length) return;
        gone.forEach(function (k) { stored.delete(k); });
        return tx('sources', 'readwrite', function (s) { gone.forEach(function (k) { s.delete(k); }); });
      });
    });
  }

  function peek() {
    return tx('meta', 'readonly', function (s) { return s.get('project'); }).then(function (json) {
      if (!json) return null;
      var p = JSON.parse(json);
      var n = 0;
      p.tracks.forEach(function (t) { n += t.clips.length; });
      if (!n) return null;
      return tx('meta', 'readonly', function (s) { return s.get('savedAt'); }).then(function (at) {
        return { project: p, savedAt: at, clips: n };
      });
    }).catch(function () { return null; });
  }

  // Restore: returns { project, buffers: Map, files: Map }.
  function load(onProgress) {
    return peek().then(function (info) {
      if (!info) return null;
      var p = info.project, ids = Object.keys(p.sources);
      var buffers = new Map(), files = new Map();
      var i = 0;
      function next() {
        if (i >= ids.length) return Promise.resolve();
        var id = ids[i++];
        onProgress && onProgress(i, ids.length);
        return tx('sources', 'readonly', function (s) { return s.get(id); }).then(function (rec) {
          if (!rec) return;
          if (rec.file) {
            files.set(id, rec.file);
            return decode(rec.file).then(function (b) { buffers.set(id, b); stored.add(id); });
          }
          var b = global.ASEditEngine.createBuffer(rec.chans.length, rec.chans[0].length, rec.sr);
          rec.chans.forEach(function (d, c) { b.copyToChannel(d, c); });
          buffers.set(id, b);
          stored.add(id);
        }).then(next);
      }
      return next().then(function () { return { project: p, buffers: buffers, files: files }; });
    });
  }

  function clear() {
    stored.clear();
    return Promise.all([
      tx('meta', 'readwrite', function (s) { s.clear(); }),
      tx('sources', 'readwrite', function (s) { s.clear(); })
    ]).catch(function () {});
  }

  /* ---------------------------------------------------------- project file */

  // 32-bit float WAV, so an effect's output survives the round trip exactly.
  function floatWav(buf) {
    var nch = buf.numberOfChannels, len = buf.length, sr = buf.sampleRate;
    var bytes = len * nch * 4;
    var ab = new ArrayBuffer(44 + bytes), v = new DataView(ab);
    function str(o, s) { for (var i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); }
    str(0, 'RIFF'); v.setUint32(4, 36 + bytes, true); str(8, 'WAVE');
    str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 3, true); v.setUint16(22, nch, true);
    v.setUint32(24, sr, true); v.setUint32(28, sr * nch * 4, true); v.setUint16(32, nch * 4, true); v.setUint16(34, 32, true);
    str(36, 'data'); v.setUint32(40, bytes, true);
    var chans = [];
    for (var c = 0; c < nch; c++) chans.push(buf.getChannelData(c));
    var o = 44;
    for (var i = 0; i < len; i++) for (var k = 0; k < nch; k++) { v.setFloat32(o, chans[k][i], true); o += 4; }
    return new Blob([ab], { type: 'audio/wav' });
  }

  function exportProject(project, buffers, files) {
    var M = global.ASEditModel;
    var used = M.usedSources(project);
    var slim = M.copy(project);
    var entries = [];
    Object.keys(slim.sources).forEach(function (id) {
      if (!used[id]) { delete slim.sources[id]; return; }
      var f = files.get(id);
      var ext = f ? ((f.name.split('.').pop() || 'bin').toLowerCase()) : 'wav';
      var path = 'sources/' + id + '.' + ext;
      slim.sources[id].path = path;
      entries.push({ name: path, blob: f || floatWav(buffers.get(id)) });
    });
    entries.unshift({ name: 'project.json', blob: new Blob([JSON.stringify(slim, null, 1)], { type: 'application/json' }) });
    return global.AudioSaw.zipBlobs(entries);
  }

  // Reads the stored (uncompressed) zips this site writes.
  function readZip(ab) {
    var v = new DataView(ab), out = {}, o = 0, dec = new TextDecoder();
    while (o + 30 <= ab.byteLength && v.getUint32(o, true) === 0x04034b50) {
      var method = v.getUint16(o + 8, true);
      var size = v.getUint32(o + 18, true);
      var nl = v.getUint16(o + 26, true), xl = v.getUint16(o + 28, true);
      var name = dec.decode(new Uint8Array(ab, o + 30, nl));
      var start = o + 30 + nl + xl;
      if (method !== 0) throw new Error('This project file is compressed; re-save it from AudioSaw.');
      out[name] = new Uint8Array(ab, start, size);
      o = start + size;
    }
    return out;
  }

  function importProject(file, onProgress) {
    return file.arrayBuffer().then(function (ab) {
      var z = readZip(ab);
      if (!z['project.json']) throw new Error('That is not an AudioSaw project file.');
      var p = JSON.parse(new TextDecoder().decode(z['project.json']));
      var ids = Object.keys(p.sources), buffers = new Map(), files = new Map(), i = 0;
      function next() {
        if (i >= ids.length) return Promise.resolve();
        var id = ids[i++], meta = p.sources[id], bytes = z[meta.path];
        onProgress && onProgress(i, ids.length);
        if (!bytes) return next();
        var f = new File([bytes], meta.name || meta.path.split('/').pop());
        if (meta.kind === 'file') files.set(id, f);
        return decode(f).then(function (b) {
          buffers.set(id, b);
          meta.duration = b.duration;
          delete meta.path;
        }).then(next);
      }
      return next().then(function () { return { project: p, buffers: buffers, files: files }; });
    });
  }

  global.ASEditStore = {
    save: save, peek: peek, load: load, clear: clear,
    exportProject: exportProject, importProject: importProject, floatWav: floatWav
  };
})(window);
