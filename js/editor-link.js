/*
 * The editor's half of the project link (project-link.js has the other half):
 * send a clip to a tool page, and take the tool's result back as one undoable
 * edit.
 *
 * The result lands the way a Process effect does: a new 'derived' source, and
 * the clip repointed at it, so undo brings the original back. The tool page
 * never touches the project itself; it only leaves a 'return' record, and this
 * file is the one place that turns that into an edit.
 *
 * Two things a returned file gets wrong on its own:
 *
 *   - An encoder adds silence at the front. lamejs adds 25 ms (measured by
 *     tools/check-project-link.js through /noise-reduction), which on a clip
 *     layered against other tracks is an audible flam. For a
 *     tool that keeps the length, align() finds that offset by
 *     cross-correlating against what was sent, and trims it. When the result
 *     does not correlate with the original (a reverser, a pitch shift), the
 *     offset cannot be measured and the result is only cut or padded to length.
 *   - The project may have moved on while the tool was open. The clip's
 *     fingerprint (M.targetPrint) says whether it is still the audio that was
 *     sent; if not, the user decides rather than the code.
 */
(function (global) {
  'use strict';

  var M = global.ASEditModel, L = global.ASLink, G = global.AS_GRAPH, V = global.ASEditView;
  var E = global.ASEditEngine, CV = global.CV;
  if (!M || !L || !G || !V || !E || !CV) {
    console.error('[editor-link] a script is missing or loaded out of order.');
    return;
  }

  var ctx = null;

  // Longest clip that may be sent. A 16-bit stereo WAV is 10 MB a minute, and
  // the tool will decode it again into float: on a phone, ten minutes is
  // already a lot of memory for one tab.
  function maxSeconds() {
    var coarse = global.matchMedia && global.matchMedia('(pointer: coarse)').matches;
    var mem = global.navigator.deviceMemory;
    return (coarse || (mem && mem <= 4)) ? 600 : 1800;
  }

  function projectTools() {
    return Object.keys(G.TOOLS).filter(function (s) { return G.TOOLS[s].project && !G.TOOLS[s].external; });
  }

  /* ------------------------------------------------------------------ send */

  function toolSheet() {
    var ids = ctx.selIds();
    if (ids.length !== 1) { ctx.status('warn', 'Select one clip to send to a tool.'); return; }
    var c = M.findClip(ctx.S.project, ids[0]).clip;
    var slugs = projectTools();
    var html = '<p class="ed-sheet-note">Opens the tool with this clip loaded. When it is done, its result comes back here and replaces the clip, as one change you can undo.</p>' +
      '<div class="ed-fx-grid">' + slugs.map(function (s) {
        var t = G.TOOLS[s];
        return '<button type="button" class="ed-fx" data-v="' + s + '"><strong>' + ctx.esc(t.title) + '</strong><small>' + ctx.esc(t.blurb) + '</small></button>';
      }).join('') + '</div>';
    ctx.openSheet('Send “' + c.name + '” to a tool', html, function (v) {
      ctx.closeSheet();
      if (G.TOOLS[v]) send(v, ids[0]);
    });
  }

  function send(slug, clipId) {
    if (ctx.isBusy()) return;
    var p = ctx.S.project;
    var f = M.findClip(p, clipId);
    if (!f) return;
    var c = f.clip, src = ctx.buffers.get(c.sourceId);
    if (!src) { ctx.status('error', 'That clip’s audio is not loaded.'); return; }
    var cap = maxSeconds();
    if (c.duration > cap) {
      ctx.status('warn', 'That clip is ' + L.fmtTime(c.duration) + ' long. Tools can take up to ' + (cap / 60) + ' minutes from here: split it, or export it and open the tool directly.');
      return;
    }
    ctx.stopPlayback();

    // If autosave is off (the project outgrew the browser's storage), leaving
    // this page would lose the project. Open the tool beside it instead; the
    // result comes back over the BroadcastChannel. The window is opened now,
    // inside the click, or a popup blocker eats it.
    var inNewTab = ctx.saveDisabled();
    var win = inNewTab ? global.open('', '_blank') : null;

    var seg = ctx.slice(src, c.offset, c.duration);
    var wav = global.AudioSaw.audioBufferToWav(seg);
    var rec = {
      v: 1, id: L.uid('k'), projectId: p.id, projectName: p.name || 'Untitled project',
      kind: 'clip', ref: { clipId: clipId, trackId: f.track.id },
      fp: M.targetPrint(p, { clipId: clipId }), tool: slug,
      name: (c.name || 'clip') + '.wav', blob: wav,
      duration: seg.duration, channels: seg.numberOfChannels, sampleRate: seg.sampleRate,
      peaks: L.peaksOf(seg), createdAt: Date.now()
    };
    ctx.setBusy(true);
    ctx.status('info', 'Handing “' + c.name + '” to ' + G.TOOLS[slug].title + '…');

    roomFor(wav.size).then(function () {
      return L.putTarget(rec);
    }).then(function () {
      L.persist();
      return inNewTab ? null : ctx.flushSave();
    }).then(function () {
      L.setFlag({ id: p.id, name: rec.projectName, at: Date.now(), target: rec.id });
      CV.track('next_step_click', { tool: 'audio-editor', to_tool: slug, placement: 'project' });
      var url = '/' + slug + '?from=project';
      if (win) { win.location.href = url; ctx.status('success', 'Opened ' + G.TOOLS[slug].title + ' in a new tab. Its result will come back here.'); }
      else global.location.href = url;
    }).catch(function (err) {
      if (win) try { win.close(); } catch (e) {}
      ctx.status('error', 'Could not hand the clip over: ' + ((err && err.message) || 'storage refused it') + '. Export the clip and open the tool directly instead.');
    }).then(function () { ctx.setBusy(false); });
  }

  // The target, the return and the derived source the editor then stores are
  // each about this size. Refuse up front rather than fail half-way.
  function roomFor(bytes) {
    var st = global.navigator.storage;
    if (!st || !st.estimate) return Promise.resolve();
    return st.estimate().then(function (e) {
      if (e && e.quota && e.quota - (e.usage || 0) < bytes * 3) {
        throw new Error('the browser has too little storage left for a ' + CV.fmtBytes(bytes) + ' clip');
      }
    }, function () {});
  }

  /* --------------------------------------------------------------- return */

  // Startup: if a result is waiting, restore the project it belongs to and
  // apply it. Resolves true when it took over from the usual restore banner.
  function checkReturn() {
    L.purge();
    return L.peekReturn().then(function (ret) {
      if (!ret || !ret.blob) return false;
      return global.ASEditStore.peek().then(function (info) {
        if (info && info.project.id === ret.projectId) {
          return ctx.restore().then(function (ok) {
            if (!ok) return false;
            return takeAndApply().then(function () { return true; });
          });
        }
        orphan(ret);
        return false;
      });
    }).catch(function () { return false; });
  }

  // A result whose project is not the one saved here (a new project was
  // started, or storage was cleared). Nothing to replace, so offer it as audio.
  function orphan(ret) {
    var title = (G.TOOLS[ret.tool] || {}).title || 'a tool';
    ctx.openSheet('A result from ' + title + ' is waiting', '<p class="ed-sheet-note">“' + ctx.esc(ret.name) + '” came back from ' + ctx.esc(title) + ', but the project it was made for is not the one saved in this browser any more.</p>' +
      ctx.menuHtml([
        { v: 'add', label: 'Add it on a new track', hint: 'At the playhead' },
        { v: 'drop', label: 'Discard it', danger: true }
      ]), function (v) {
      ctx.closeSheet();
      L.takeReturn().then(function (r) {
        if (!r) return;
        if (v === 'add') ctx.importFiles([new File([r.blob], r.name, { type: r.blob.type || 'audio/wav' })], { mode: 'tracks', t: ctx.S.playhead });
        finish(null);
      });
    });
  }

  var queued = false;
  function takeAndApply() {
    if (ctx.isBusy()) {
      // A result arriving over the channel mid-import waits its turn.
      if (!queued) { queued = true; setTimeout(function () { queued = false; takeAndApply(); }, 500); }
      return Promise.resolve();
    }
    return Promise.all([L.takeReturn(), L.getTarget()]).then(function (r) {
      var ret = r[0], target = r[1];
      if (!ret) return;
      if (!target || target.id !== ret.targetId) target = null;
      return apply(ret, target);
    });
  }

  function apply(ret, target) {
    var mode = (G.TOOLS[ret.tool] || {}).project || 'len';
    var title = (G.TOOLS[ret.tool] || {}).title || ret.tool;
    ctx.setBusy(true);
    ctx.status('info', 'Bringing back the result from ' + title + '…');
    var file = new File([ret.blob], ret.name, { type: ret.blob.type || '' });
    var sent = target && target.blob ? global.AudioSaw.decodeToAudioBuffer(target.blob).catch(function () { return null; }) : Promise.resolve(null);
    return Promise.all([ctx.decodeFile(file, function (m) { ctx.status('info', m); }), sent]).then(function (r) {
      ctx.setBusy(false);
      var out = r[0], orig = r[1];
      var note = '';
      if (mode === 'same' && orig && Math.abs(out.duration - orig.duration) < 0.25) {
        var al = align(orig, out);
        out = al.buf;
        if (al.shift) note = ' Lined up ' + (al.shift / out.sampleRate * 1000).toFixed(0) + ' ms of encoder delay.';
      }
      place(ret, target, out, mode, title, note);
    }).catch(function (err) {
      ctx.setBusy(false);
      ctx.status('error', 'Could not open the result from ' + title + ': ' + ((err && err.message) || 'unsupported file') + '.');
      CV.track('chain_continue', { from_tool: ret.tool, to_tool: 'audio-editor', placement: 'project', accepted: false });
    });
  }

  function place(ret, target, out, mode, title, note) {
    var p = ctx.S.project;
    var state = !target ? 'gone' : M.targetPrint(p, target.ref) === target.fp ? 'fresh' : M.findClip(p, target.ref.clipId) ? 'changed' : 'gone';
    if (state === 'fresh') { commit('replace', ret, target, out, mode, title, note); return; }
    var items = [];
    if (state === 'changed') items.push({ v: 'replace', label: 'Replace the clip anyway', hint: 'It has been edited since you sent it' });
    items.push({ v: 'track', label: 'Put it on a new track', hint: target ? 'Where the clip was' : 'At the playhead' });
    items.push({ v: 'drop', label: 'Discard it', danger: true });
    ctx.openSheet('The result from ' + title + ' is back',
      '<p class="ed-sheet-note">' + (state === 'changed'
        ? 'The clip you sent was edited while the tool was open, so replacing it would undo those edits.'
        : 'The clip you sent is no longer in the project.') + '</p>' + ctx.menuHtml(items), function (v) {
        ctx.closeSheet();
        if (v === 'drop') { finish(target); ctx.status('info', 'Discarded the result from ' + title + '.'); return; }
        commit(v, ret, target, out, mode, title, note);
      });
  }

  function commit(how, ret, target, out, mode, title, note) {
    var sid = null, clipId = null;
    ctx.edit(function (p) {
      var name = target ? target.name.replace(/\.wav$/i, '') : ret.name.replace(/\.[^.]+$/, '');
      sid = M.addSource(p, {
        name: name, duration: out.duration, channels: out.numberOfChannels, sampleRate: out.sampleRate, kind: 'derived'
      });
      ctx.buffers.set(sid, out);
      V.buildPeaks(sid, out);
      var f = target && M.findClip(p, target.ref.clipId);
      if (how === 'replace' && f) {
        // A same-length tool keeps everything after it where it was; one that
        // changes the length (speed, silence cutting) moves it, as Process does.
        var ripple = !(mode === 'same' && Math.abs(out.duration - f.clip.duration) < 0.05);
        M.replaceClipAudio(p, f.clip.id, sid, out.duration, ripple);
        clipId = f.clip.id;
      } else {
        var ti = f ? f.ti + 1 : p.tracks.length;
        var start = f ? f.clip.start : ctx.S.playhead;
        clipId = M.placeOnNewTrack(p, ti, sid, start, title);
      }
    });
    ctx.S.sel = {};
    if (clipId) ctx.S.sel[clipId] = true;
    ctx.S.range = null;
    ctx.refresh();
    finish(target);
    ctx.status('success', title + ' result applied.' + note + ' Undo takes it off again.');
    CV.track('chain_continue', { from_tool: ret.tool, to_tool: 'audio-editor', placement: 'project', accepted: true });
  }

  // The round trip is over: the target's audio is no use any more, and tool
  // pages stop offering it.
  function finish(target) {
    if (target) L.dropTarget().catch(function () {});
    L.setFlag({ target: null });
    try { global.history.replaceState(null, '', global.location.pathname); } catch (e) {}
  }

  /* ----------------------------------------------------------------- align */

  // Find how far `out` lags `orig` (up to 4096 samples) by cross-correlating a mono
  // window at the loudest part, drop that lead-in, and cut or pad to the exact
  // original length. Only trusted when the match is strong: a correlation
  // below 0.6 means the tool changed the waveform too much to measure, and a
  // guessed shift would be worse than none.
  function align(orig, out) {
    var n = Math.round(orig.duration * out.sampleRate);
    var shift = 0;
    if (orig.sampleRate === out.sampleRate) {
      var a = mono(orig), b = mono(out);
      var W = Math.min(16384, a.length >> 1), maxLag = Math.min(4096, b.length - W);
      if (W > 1024 && maxLag > 0) {
        var at = loudest(a, W);
        var ea = 0;
        for (var i = 0; i < W; i++) ea += a[at + i] * a[at + i];
        var best = -Infinity, bestLag = 0;
        for (var lag = 0; lag <= maxLag && at + lag + W <= b.length; lag++) {
          var s = 0;
          for (var j = 0; j < W; j++) s += a[at + j] * b[at + lag + j];
          if (s > best) { best = s; bestLag = lag; }
        }
        var eb = 0;
        for (var k = 0; k < W; k++) eb += b[at + bestLag + k] * b[at + bestLag + k];
        var r = ea > 0 && eb > 0 ? best / Math.sqrt(ea * eb) : 0;
        if (r > 0.6) shift = bestLag;
      }
    }
    var buf = E.createBuffer(out.numberOfChannels, Math.max(1, n), out.sampleRate);
    for (var c = 0; c < out.numberOfChannels; c++) {
      var d = out.getChannelData(c).subarray(shift, shift + n);
      buf.copyToChannel(d, c);
    }
    return { buf: buf, shift: shift };
  }

  function mono(buf) {
    if (buf.numberOfChannels === 1) return buf.getChannelData(0);
    var l = buf.getChannelData(0), r = buf.getChannelData(1), m = new Float32Array(buf.length);
    for (var i = 0; i < m.length; i++) m[i] = (l[i] + r[i]) * 0.5;
    return m;
  }

  function loudest(x, W) {
    var best = 0, at = 0, step = W >> 1;
    for (var s = 0; s + W <= x.length; s += step) {
      var e = 0;
      for (var i = s; i < s + W; i += 4) e += x[i] * x[i];
      if (e > best) { best = e; at = s; }
    }
    return at;
  }

  /* ------------------------------------------------------------------ init */

  function init(c) {
    ctx = c;
    var ch = L.channel();
    if (ch) {
      ch.addEventListener('message', function (e) {
        var d = e.data || {};
        if (d.t === 'ping') ch.postMessage({ t: 'pong', projectId: ctx.S.project.id });
        if (d.t === 'return') takeAndApply();
      });
    }
  }

  global.ASEditLink = {
    init: init, toolSheet: toolSheet, send: send, checkReturn: checkReturn,
    projectTools: projectTools, align: align
  };
})(window);
