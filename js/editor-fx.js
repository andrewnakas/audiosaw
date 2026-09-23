/*
 * Effects for the audio editor. Each one takes an AudioBuffer and returns a new
 * one; none of them touch their input, because the input is a source that undo
 * snapshots may still point at. The editor stores the output as a new source
 * and points the clip at it, so an effect is undoable like any other edit.
 *
 * Almost nothing here is new DSP. Each effect calls the module the site's own
 * single-purpose tool already uses and checks:
 *
 *   loudness   js/loudness.js     (BS.1770-4, validated against ffmpeg ebur128)
 *   denoise    js/noise-reduction.js's spectral gate
 *   pauses     js/silence-gaps.js (checked by tools/check-silence.js)
 *   reverb     js/slowed-reverb.js
 *   speed/pitch  ffmpeg's atempo, the same filter /audio-speed and
 *                /pitch-shifter run
 *
 * so an effect in the editor sounds exactly like the tool of the same name.
 */
(function (global) {
  'use strict';

  var Octx = global.OfflineAudioContext || global.webkitOfflineAudioContext;

  function chansCopy(buf) {
    var out = [];
    for (var c = 0; c < buf.numberOfChannels; c++) out.push(new Float32Array(buf.getChannelData(c)));
    return out;
  }

  function fromChans(chans, sr) {
    var buf = global.ASEditEngine.createBuffer(chans.length, chans[0].length, sr);
    for (var c = 0; c < chans.length; c++) buf.copyToChannel(chans[c], c);
    return buf;
  }

  function peakOf(chans) {
    var p = 0;
    chans.forEach(function (d) {
      for (var i = 0; i < d.length; i++) { var v = d[i] < 0 ? -d[i] : d[i]; if (v > p) p = v; }
    });
    return p;
  }

  function scale(chans, g) {
    chans.forEach(function (d) { for (var i = 0; i < d.length; i++) d[i] *= g; });
  }

  var tick = function () { return new Promise(function (r) { setTimeout(r, 0); }); };

  // Run an OfflineAudioContext graph over the buffer. `wire(ctx, src)` returns
  // the node to connect to the destination.
  function offline(buf, wire, extraSeconds) {
    var len = buf.length + Math.ceil((extraSeconds || 0) * buf.sampleRate);
    var off = new Octx(Math.max(1, buf.numberOfChannels), len, buf.sampleRate);
    var src = off.createBufferSource();
    src.buffer = buf;
    var out = wire(off, src);
    out.connect(off.destination);
    src.start(0);
    return off.startRendering();
  }

  /* -------------------------------------------------------------- effects */

  var EQ = {
    bass:    [['lowshelf', 110, 0, 7], ['peaking', 400, 0.9, -1]],
    voice:   [['highpass', 80, 0.7, 0], ['lowshelf', 200, 0, -3], ['peaking', 3200, 0.8, 4], ['highshelf', 9000, 0, 1.5]],
    rumble:  [['highpass', 80, 0.7, 0], ['highpass', 80, 0.7, 0]],
    treble:  [['highshelf', 5000, 0, 5]],
    warm:    [['lowshelf', 180, 0, 3], ['highshelf', 6000, 0, -3]],
    phone:   [['highpass', 300, 0.7, 0], ['lowpass', 3400, 0.7, 0], ['peaking', 1500, 1, 5]],
    muffle:  [['lowpass', 900, 0.7, 0]]
  };

  var DENOISE = {
    gentle: { sensitivity: 9, reduction: 10 },
    medium: { sensitivity: 13, reduction: 18 },
    strong: { sensitivity: 17, reduction: 26 }
  };

  function atempoChain(rate) {
    var parts = [], r = rate;
    while (r > 2.0) { parts.push('atempo=2.0'); r /= 2.0; }
    while (r < 0.5) { parts.push('atempo=0.5'); r /= 0.5; }
    parts.push('atempo=' + r.toFixed(6));
    return parts.join(',');
  }

  // Through ffmpeg.wasm: write a WAV, run one filter, decode what comes back.
  function viaFFmpeg(buf, filter, onProgress) {
    onProgress && onProgress(5, 'Loading the audio engine…');
    return global.AudioSaw.ensureFFmpeg(null, function (got, total, source) {
      if (onProgress && source === 'network' && total) {
        onProgress(5 + 45 * got / total, 'Downloading codec… ' + (got / 1048576).toFixed(1) + ' of ' + (total / 1048576).toFixed(1) + ' MB (first time only)');
      }
    }).then(function (pack) {
      var ff = pack.ffmpeg, stamp = Date.now();
      var inName = 'ed_in_' + stamp + '.wav', outName = 'ed_out_' + stamp + '.wav';
      var wav = global.AudioSaw.audioBufferToWav(buf);
      function prog(e) { if (onProgress && e && e.progress != null) onProgress(55 + Math.min(40, e.progress * 40), 'Processing…'); }
      return wav.arrayBuffer().then(function (ab) {
        return ff.writeFile(inName, new Uint8Array(ab));
      }).then(function () {
        ff.on('progress', prog);
        return ff.exec(['-i', inName, '-af', filter, '-c:a', 'pcm_f32le', outName]);
      }).then(function () {
        return ff.readFile(outName);
      }).then(function (data) {
        try { ff.off('progress', prog); } catch (e) {}
        try { ff.deleteFile(inName); ff.deleteFile(outName); } catch (e) {}
        return global.AudioSaw.decodeToAudioBuffer(new File([data.buffer], 'fx.wav', { type: 'audio/wav' }));
      });
    });
  }

  var FX = {
    normalize: {
      label: 'Normalize', hint: 'Loudest peak to -1 dB',
      run: function (buf) {
        var ch = chansCopy(buf), p = peakOf(ch);
        if (p < 1e-6) throw new Error('That part is silent.');
        scale(ch, Math.pow(10, -1 / 20) / p);
        return fromChans(ch, buf.sampleRate);
      }
    },
    loudness: {
      label: 'Loudness', hint: 'Match a LUFS target',
      options: [['-14', '-14 LUFS · Spotify, YouTube'], ['-16', '-16 LUFS · podcasts, Apple'], ['-23', '-23 LUFS · broadcast']],
      run: function (buf, opt) {
        var L = global.ASLoudness;
        var target = parseFloat(opt || '-14');
        var measure = buf.sampleRate === L.SPEC_RATE ? Promise.resolve(buf) : global.AudioSaw.resampleBuffer(buf, L.SPEC_RATE);
        return measure.then(function (mb) {
          var mc = [];
          for (var c = 0; c < mb.numberOfChannels; c++) mc.push(mb.getChannelData(c));
          var lufs = L.integratedLoudness(mc, mb.sampleRate).integrated;
          if (!isFinite(lufs)) throw new Error('Too quiet to measure — is that part silent?');
          var ch = chansCopy(buf);
          var want = target - lufs;
          // True peak on the buffer actually written, never on a resampled copy:
          // resampling moves inter-sample peaks (see CLAUDE.md on loudness.js).
          var tp = L.toDb(L.truePeak(ch));
          var allowed = Math.min(want, -1 - tp);
          scale(ch, Math.pow(10, allowed / 20));
          var out = fromChans(ch, buf.sampleRate);
          out._note = 'Measured ' + lufs.toFixed(1) + ' LUFS, applied ' + (allowed >= 0 ? '+' : '') + allowed.toFixed(1) + ' dB' +
            (allowed < want - 0.05 ? ' (held back to keep peaks under -1 dBTP)' : '');
          return out;
        });
      }
    },
    denoise: {
      label: 'Remove noise', hint: 'Hiss, hum, fan noise',
      options: [['medium', 'Medium'], ['gentle', 'Gentle'], ['strong', 'Strong']],
      run: function (buf, opt, onProgress) {
        if (!global.ASDenoise) throw new Error('Noise reduction did not load.');
        var s = DENOISE[opt] || DENOISE.medium;
        var ch = chansCopy(buf), out = [];
        var i = 0;
        function next() {
          if (i >= ch.length) return Promise.resolve(fromChans(out, buf.sampleRate));
          var idx = i++;
          return tick().then(function () {
            out.push(global.ASDenoise.channel(ch[idx], s, function (pct) {
              onProgress && onProgress((idx + pct / 100) / ch.length * 100, 'Removing noise…');
            }));
            return next();
          });
        }
        return next();
      }
    },
    pauses: {
      label: 'Shorten pauses', hint: 'Tighten gaps in speech',
      changesLength: true,
      options: [['0.25', 'Leave 0.25 s'], ['0.4', 'Leave 0.4 s'], ['0.1', 'Leave 0.1 s']],
      run: function (buf, opt) {
        var S = global.ASSilence;
        var ch = chansCopy(buf);
        var keep = parseFloat(opt || '0.25');
        var p = S.plan(ch, buf.sampleRate, { keepSilence: keep, minSilence: Math.max(0.5, keep + 0.2) });
        if (!p.keep.length) throw new Error('No speech found in that part.');
        var r = S.render(ch, buf.sampleRate, p, { crossfade: 0.008 });
        // With nothing to shorten, hand back the audio untouched: render()
        // would still trim the quiet head and tail, which is not what was asked.
        if (!r.cuts) {
          var same = fromChans(chansCopy(buf), buf.sampleRate);
          same._note = 'No pauses long enough to shorten';
          return same;
        }
        var out = fromChans(r.channels, buf.sampleRate);
        out._note = 'Shortened ' + r.cuts + ' pause' + (r.cuts === 1 ? '' : 's') + ', ' + (r.removed / buf.sampleRate).toFixed(1) + ' s removed';
        return out;
      }
    },
    eq: {
      label: 'EQ', hint: 'Tone presets',
      options: [['voice', 'Voice clarity'], ['bass', 'Bass boost'], ['rumble', 'Remove rumble'], ['treble', 'Brighter'], ['warm', 'Warmer'], ['phone', 'Telephone'], ['muffle', 'Muffled / next room']],
      run: function (buf, opt) {
        var chain = EQ[opt] || EQ.voice;
        return offline(buf, function (off, src) {
          var node = src;
          chain.forEach(function (b) {
            var f = off.createBiquadFilter();
            f.type = b[0]; f.frequency.value = b[1];
            if (b[2]) f.Q.value = b[2];
            f.gain.value = b[3];
            node.connect(f); node = f;
          });
          return node;
        }).then(function (out) { global.ASReverb.limitPeak(out, 0.99); return out; });
      }
    },
    compress: {
      label: 'Compress', hint: 'Even out loud and quiet',
      options: [['medium', 'Medium'], ['gentle', 'Gentle'], ['heavy', 'Heavy']],
      run: function (buf, opt) {
        var s = { gentle: [-18, 2.5], medium: [-24, 4], heavy: [-32, 8] }[opt] || [-24, 4];
        var before = peakOf(chansCopy(buf));
        return offline(buf, function (off, src) {
          var comp = off.createDynamicsCompressor();
          comp.threshold.value = s[0]; comp.ratio.value = s[1];
          comp.knee.value = 8; comp.attack.value = 0.005; comp.release.value = 0.2;
          src.connect(comp);
          return comp;
        }).then(function (out) {
          // Make-up gain back to the original peak, so it sounds evened out
          // rather than simply quieter.
          var ch = chansCopy(out), after = peakOf(ch);
          if (after > 1e-6) scale(ch, Math.min(before, 0.99) / after);
          return fromChans(ch, out.sampleRate);
        });
      }
    },
    reverb: {
      label: 'Reverb', hint: 'Room, hall, cathedral',
      tail: true,
      options: [['room', 'Room'], ['hall', 'Hall'], ['huge', 'Cathedral']],
      run: function (buf, opt) {
        var s = { room: [0.8, 0.22, 5200], hall: [2.2, 0.32, 4200], huge: [4.5, 0.4, 3600] }[opt] || [0.8, 0.22, 5200];
        return global.ASReverb.render(buf, { speed: 1, seconds: s[0], mix: s[1], damp: s[2] });
      }
    },
    echo: {
      label: 'Echo', hint: 'Repeating delay',
      tail: true,
      options: [['0.3', 'Short (0.3 s)'], ['0.12', 'Slapback (0.12 s)'], ['0.6', 'Long (0.6 s)']],
      run: function (buf, opt) {
        var d = parseFloat(opt || '0.3');
        return offline(buf, function (off, src) {
          var out = off.createGain();
          var delay = off.createDelay(2); delay.delayTime.value = d;
          var fb = off.createGain(); fb.gain.value = 0.4;
          var wet = off.createGain(); wet.gain.value = 0.5;
          src.connect(out);
          src.connect(delay); delay.connect(fb); fb.connect(delay); delay.connect(wet); wet.connect(out);
          return out;
        }, d * 8).then(function (out) { global.ASReverb.limitPeak(out, 0.99); return out; });
      }
    },
    speed: {
      label: 'Speed', hint: 'Faster or slower, same pitch',
      changesLength: true, ffmpeg: true,
      options: [['1.25', '1.25× faster'], ['1.5', '1.5× faster'], ['2', '2× faster'], ['0.9', '0.9× slower'], ['0.75', '0.75× slower'], ['0.5', '0.5× slower']],
      run: function (buf, opt, onProgress) {
        return viaFFmpeg(buf, atempoChain(parseFloat(opt || '1.25')), onProgress);
      }
    },
    // Not in the Process menu: opened from "Fit to the project tempo…" with
    // opt = "<rate>@<target bpm>", so the new source can record its tempo.
    tempoFit: {
      label: 'Fit to tempo', hint: 'Stretch to the project tempo, same pitch',
      changesLength: true, ffmpeg: true,
      run: function (buf, opt, onProgress) {
        var parts = String(opt).split('@'), rate = parseFloat(parts[0]), bpm = parseFloat(parts[1]);
        return viaFFmpeg(buf, atempoChain(rate), onProgress).then(function (out) {
          // atempo comes back a few milliseconds long (measured: 15 ms on a
          // 19.5 s loop). A loop has to be exactly its bars long or it drifts
          // off the grid on every repeat, so hold it to length / rate.
          var want = Math.round(buf.length / rate);
          if (out.sampleRate === buf.sampleRate && Math.abs(out.length - want) < out.sampleRate * 0.1) {
            out = fromChans(chansCopy(out).map(function (d) {
              var n = new Float32Array(want); n.set(d.subarray(0, want)); return n;
            }), out.sampleRate);
          }
          if (bpm > 0) out._meta = { bpm: bpm };
          return out;
        });
      }
    },
    pitch: {
      label: 'Pitch', hint: 'Change key, same speed',
      ffmpeg: true,
      options: [['2', '+2 semitones'], ['1', '+1 semitone'], ['-1', '-1 semitone'], ['-2', '-2 semitones'], ['12', '+1 octave'], ['-12', '-1 octave'], ['5', '+5 (a fourth)'], ['-5', '-5 (a fourth down)']],
      run: function (buf, opt, onProgress) {
        var st = parseFloat(opt || '2'), r = Math.pow(2, st / 12), sr = buf.sampleRate;
        return viaFFmpeg(buf, 'asetrate=' + Math.round(sr * r) + ',aresample=' + sr + ',' + atempoChain(1 / r), onProgress)
          .then(function (out) {
            // atempo can come back a few samples long or short; hold the length.
            if (Math.abs(out.length - buf.length) < out.sampleRate * 0.05 && out.sampleRate === sr) {
              var ch = chansCopy(out).map(function (d) {
                var n = new Float32Array(buf.length); n.set(d.subarray(0, buf.length)); return n;
              });
              return fromChans(ch, sr);
            }
            return out;
          });
      }
    },
    vinyl: {
      label: 'Tape speed', hint: 'Speed and pitch together',
      changesLength: true,
      options: [['0.8', 'Slowed (0.8×)'], ['0.9', '0.9×'], ['1.1', '1.1×'], ['1.25', 'Nightcore (1.25×)']],
      run: function (buf, opt) {
        var r = parseFloat(opt || '0.8');
        var len = Math.ceil(buf.length / r);
        var off = new Octx(buf.numberOfChannels, len, buf.sampleRate);
        var src = off.createBufferSource();
        src.buffer = buf; src.playbackRate.value = r;
        src.connect(off.destination); src.start(0);
        return off.startRendering();
      }
    },
    reverse: {
      label: 'Reverse', hint: 'Play it backwards',
      run: function (buf) {
        var ch = chansCopy(buf);
        ch.forEach(function (d) { Array.prototype.reverse.call(d); });
        return fromChans(ch, buf.sampleRate);
      }
    },
    mono: {
      label: 'Make mono', hint: 'Both sides the same',
      run: function (buf) {
        var ch = chansCopy(buf);
        if (ch.length < 2) return fromChans(ch, buf.sampleRate);
        var m = new Float32Array(ch[0].length);
        ch.forEach(function (d) { for (var i = 0; i < d.length; i++) m[i] += d[i] / ch.length; });
        return fromChans([m], buf.sampleRate);
      }
    },
    swap: {
      label: 'Swap L/R', hint: 'Mirror the stereo image',
      run: function (buf) {
        var ch = chansCopy(buf);
        if (ch.length === 2) ch.reverse();
        return fromChans(ch, buf.sampleRate);
      }
    },
    invert: {
      label: 'Invert', hint: 'Flip polarity',
      run: function (buf) {
        var ch = chansCopy(buf); scale(ch, -1);
        return fromChans(ch, buf.sampleRate);
      }
    },
    silence: {
      label: 'Silence', hint: 'Replace with quiet',
      run: function (buf) {
        var ch = [];
        for (var c = 0; c < buf.numberOfChannels; c++) ch.push(new Float32Array(buf.length));
        return fromChans(ch, buf.sampleRate);
      }
    }
  };

  var ORDER = ['normalize', 'loudness', 'denoise', 'eq', 'compress', 'pauses', 'reverb', 'echo',
    'speed', 'pitch', 'vinyl', 'reverse', 'mono', 'swap', 'invert', 'silence'];

  function apply(id, buf, opt, onProgress) {
    var fx = FX[id];
    if (!fx) return Promise.reject(new Error('Unknown effect'));
    return tick().then(function () { return fx.run(buf, opt, onProgress); });
  }

  // Cut a render down to `maxLen` samples with a short fade, for effects whose
  // tail would otherwise run into the next clip.
  function fitTail(buf, maxLen) {
    if (buf.length <= maxLen) return buf;
    var fade = Math.min(maxLen, Math.round(buf.sampleRate * 0.05));
    var ch = [];
    for (var c = 0; c < buf.numberOfChannels; c++) {
      var d = new Float32Array(buf.getChannelData(c).subarray(0, maxLen));
      for (var i = 0; i < fade; i++) d[maxLen - 1 - i] *= i / fade;
      ch.push(d);
    }
    var out = fromChans(ch, buf.sampleRate);
    out._note = buf._note;
    return out;
  }

  global.ASEditFx = { FX: FX, ORDER: ORDER, apply: apply, fitTail: fitTail, chansCopy: chansCopy, fromChans: fromChans };
})(window);
