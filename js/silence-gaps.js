/*
 * Removes the silence *between* phrases, not just at the ends.
 *
 * The site declined to do this for a long time, and the stated reason was
 * right: done naively it sounds terrible. Three things cause that, and each is
 * handled here rather than hoped away.
 *
 *   1. Cutting mid-word. A single quiet frame inside a word — the closure
 *      before a plosive, the gap in "back to" — looks exactly like silence to a
 *      simple threshold. Fixed with hysteresis plus a hangover: the detector
 *      needs sustained quiet before it believes a phrase has ended.
 *   2. Clicks at every join. Butting two segments together leaves a step in the
 *      waveform. Fixed with a short equal-power crossfade at each seam.
 *   3. Speech that sounds rushed and inhuman. Removing pauses *entirely* is the
 *      single biggest giveaway of a machine-edited recording; listeners read the
 *      gaps as punctuation. So gaps are SHORTENED to a floor, never deleted.
 *
 * The threshold is derived from the file's own noise floor rather than set in
 * absolute dBFS, because nobody knows their room's noise floor and the right
 * answer differs by 30 dB between a treated booth and a laptop in a kitchen.
 */
(function (global) {
  'use strict';

  function rmsFrames(mono, frameLen, hop) {
    var count = Math.max(0, Math.floor((mono.length - frameLen) / hop) + 1);
    var out = new Float32Array(count);
    for (var f = 0; f < count; f++) {
      var s = 0, start = f * hop, end = start + frameLen;
      for (var i = start; i < end; i++) s += mono[i] * mono[i];
      out[f] = Math.sqrt(s / frameLen);
    }
    return out;
  }

  // The noise floor is the level the quiet parts sit at. A low percentile finds
  // it without being fooled by however much speech the file contains — a mean
  // would be dragged up by a talkative recording and down by a sparse one.
  function noiseFloor(frames) {
    var sorted = Array.prototype.slice.call(frames).sort(function (a, b) { return a - b; });
    if (!sorted.length) return 0;
    return sorted[Math.floor(sorted.length * 0.10)];
  }

  function toMono(channels) {
    var n = channels[0].length, ch = channels.length;
    var out = new Float32Array(n);
    for (var c = 0; c < ch; c++) {
      var d = channels[c];
      for (var i = 0; i < n; i++) out[i] += d[i] / ch;
    }
    return out;
  }

  /*
   * opts:
   *   marginDb     how far above the noise floor counts as speech (default 9)
   *   minSilence   seconds of quiet before a gap is worth cutting (default 0.5)
   *   keepSilence  seconds of gap to leave behind (default 0.2)
   *   padding      seconds kept either side of speech (default 0.08)
   *   crossfade    seconds of fade at each join (default 0.008)
   */
  function plan(channels, sampleRate, opts) {
    opts = opts || {};
    var marginDb = opts.marginDb === undefined ? 9 : opts.marginDb;
    var minSilence = opts.minSilence === undefined ? 0.5 : opts.minSilence;
    var keepSilence = opts.keepSilence === undefined ? 0.2 : opts.keepSilence;
    var padding = opts.padding === undefined ? 0.08 : opts.padding;

    var mono = toMono(channels);
    var n = mono.length;
    var hop = Math.max(1, Math.round(sampleRate * 0.010));      // 10 ms
    var frameLen = Math.max(hop, Math.round(sampleRate * 0.020));
    var frames = rmsFrames(mono, frameLen, hop);
    if (!frames.length) return { keep: [[0, n]], floorDb: -Infinity, thresholdDb: -Infinity };

    var floor = noiseFloor(frames);
    var floorDb = floor > 0 ? 20 * Math.log10(floor) : -90;
    // An absolute backstop: in a genuinely silent digital file the floor is 0
    // and everything would count as speech.
    var thresholdDb = Math.max(floorDb + marginDb, -70);
    var openLevel = Math.pow(10, thresholdDb / 20);
    var closeLevel = Math.pow(10, (thresholdDb - 3) / 20);       // hysteresis

    // Hangover: how many quiet frames before we accept the phrase has ended.
    var hangFrames = Math.max(1, Math.round(minSilence / 0.010));

    var speech = [];
    var inSpeech = false, startF = 0, quiet = 0;
    for (var f = 0; f < frames.length; f++) {
      var v = frames[f];
      if (!inSpeech) {
        if (v > openLevel) { inSpeech = true; startF = f; quiet = 0; }
      } else {
        if (v < closeLevel) {
          quiet++;
          if (quiet >= hangFrames) {
            speech.push([startF, f - quiet + 1]);
            inSpeech = false; quiet = 0;
          }
        } else { quiet = 0; }
      }
    }
    if (inSpeech) speech.push([startF, frames.length]);
    if (!speech.length) return { keep: [], floorDb: floorDb, thresholdDb: thresholdDb, speechCount: 0 };

    // Frames to samples, with padding either side so nothing is clipped off.
    var pad = Math.round(padding * sampleRate);
    var keep = speech.map(function (r) {
      return [
        Math.max(0, r[0] * hop - pad),
        Math.min(n, r[1] * hop + frameLen + pad)
      ];
    });

    // Merge anything that now overlaps or nearly touches.
    var merged = [keep[0]];
    for (var k = 1; k < keep.length; k++) {
      var last = merged[merged.length - 1];
      if (keep[k][0] <= last[1]) last[1] = Math.max(last[1], keep[k][1]);
      else merged.push(keep[k]);
    }

    return {
      keep: merged,
      floorDb: floorDb,
      thresholdDb: thresholdDb,
      gapFloor: Math.round(keepSilence * sampleRate),
      speechCount: merged.length
    };
  }

  /*
   * Build the output. Gaps between kept regions are shortened to gapFloor
   * rather than removed, and every seam gets an equal-power crossfade.
   */
  function render(channels, sampleRate, p, opts) {
    opts = opts || {};
    var xf = Math.max(0, Math.round((opts.crossfade === undefined ? 0.008 : opts.crossfade) * sampleRate));
    var keep = p.keep;
    if (!keep.length) return { channels: channels.map(function (c) { return c.slice(0, 0); }), cuts: 0, removed: 0 };

    var gapFloor = p.gapFloor || 0;

    // Length: kept audio, minus the crossfade overlap at each seam, plus the
    // gap we deliberately leave between phrases.
    var total = 0;
    for (var i = 0; i < keep.length; i++) total += keep[i][1] - keep[i][0];
    var seams = keep.length - 1;
    total += seams * gapFloor - seams * xf;
    if (total < 1) total = 1;

    var outCh = [];
    for (var c = 0; c < channels.length; c++) outCh.push(new Float32Array(total));

    var pos = 0, cuts = 0, removed = 0;
    for (var r = 0; r < keep.length; r++) {
      var s = keep[r][0], e = keep[r][1], len = e - s;
      for (var ch = 0; ch < channels.length; ch++) {
        var src = channels[ch], dst = outCh[ch];
        if (r === 0) {
          for (var j = 0; j < len && pos + j < total; j++) dst[pos + j] = src[s + j];
        } else {
          // Equal-power crossfade over the first xf samples, laid on top of the
          // tail already written. sqrt weights keep perceived level constant
          // through the seam; linear weights dip audibly.
          for (var x = 0; x < xf && pos - xf + x < total; x++) {
            var t = (x + 1) / (xf + 1);
            var a = Math.sqrt(1 - t), b = Math.sqrt(t);
            var idx = pos - xf + x;
            if (idx >= 0) dst[idx] = dst[idx] * a + src[s + x] * b;
          }
          for (var j2 = xf; j2 < len && pos - xf + j2 < total; j2++) {
            dst[pos - xf + j2] = src[s + j2];
          }
        }
      }
      if (r === 0) pos += len; else { pos += len - xf; cuts++; }

      if (r < keep.length - 1) {
        var gapOriginal = keep[r + 1][0] - e;
        removed += Math.max(0, gapOriginal - gapFloor);
        pos += gapFloor;   // leave a real pause; the buffer is already zeroed
      }
    }

    return { channels: outCh, cuts: cuts, removed: removed, length: total };
  }

  global.ASSilence = { plan: plan, render: render, rmsFrames: rmsFrames, noiseFloor: noiseFloor, toMono: toMono };
})(typeof window !== 'undefined' ? window : globalThis);
