/*
 * Pitch / key changer — shifts pitch without changing tempo.
 *
 * The complement to audio-speed.js, which changes tempo without changing pitch.
 * Same underlying trick, run the other way round:
 *
 *   asetrate=sr*r   replay the samples at a different rate. Pitch and tempo
 *                   both move by r, exactly like speeding up a record.
 *   aresample=sr    put the sample rate back so players read it correctly.
 *   atempo=1/r      undo the tempo change, leaving only the pitch change.
 *
 * Reusing ffmpeg's atempo (as audio-speed.js already does) rather than hand-
 * rolling a phase vocoder: atempo is a well-tuned WSOLA implementation, and the
 * WebAssembly build is already being downloaded for other conversions on the
 * site, so this costs nothing extra.
 */
(function () {
  'use strict';

  // atempo is only defined for 0.5–2.0, so larger corrections are chained.
  function atempoChain(rate) {
    if (rate >= 0.5 && rate <= 2.0) return 'atempo=' + rate.toFixed(6);
    var parts = [];
    var remaining = rate;
    while (remaining > 2.0) { parts.push('atempo=2.0'); remaining /= 2.0; }
    while (remaining < 0.5) { parts.push('atempo=0.5'); remaining /= 0.5; }
    parts.push('atempo=' + remaining.toFixed(6));
    return parts.join(',');
  }

  function process(file, opts, onProgress) {
    var semitones = opts.semitones;
    if (!semitones) throw new Error('Pick a number of semitones other than zero.');

    // Equal temperament: each semitone is the twelfth root of two.
    var ratio = Math.pow(2, semitones / 12);

    onProgress(10, 'Loading codec…');
    var ext = (file.name.split('.').pop() || 'bin').toLowerCase();
    var srcInfo = null;
    return file.slice(0, 1 << 20).arrayBuffer().then(function (head) {
      // asetrate takes a literal rate, so the source rate has to be known:
      // assuming 48 kHz and feeding it a 44.1 kHz file shifts by the wrong
      // interval entirely (+2 semitones becomes +3.5). The header says; if it
      // cannot be read, ask ffmpeg's own stream report.
      srcInfo = AudioSaw.sniffFormat(head);
      if (srcInfo && srcInfo.sampleRate) return srcInfo.sampleRate;
      return probeRate(file, ext);
    }).then(function (sourceRate) {
      onProgress(30, 'Shifting pitch…');
      // ffmpeg's resampler at 64 taps rather than its default 16, and
      // 32-bit float out at the file's own rate; our encoder writes the
      // chosen format, so bit depth and LAME behave as on every other tool.
      var filter = 'asetrate=' + Math.round(sourceRate * ratio) +
                   ',aresample=' + sourceRate + ':filter_size=64:phase_shift=10:cutoff=0.97,' + atempoChain(1 / ratio);
      return AudioSaw.runFFmpeg(file, ext, ['-af', filter, '-c:a', 'pcm_f32le', '-vn'], 'wav', 'audio/wav',
        function (pct) { onProgress(30 + Math.min(55, pct * 0.55), 'Shifting pitch…'); }, 'Shifting pitch…');
    }).then(function (wav) {
      return AudioSaw.decodeToAudioBuffer(new File([wav], 'shifted.wav'));
    }).then(function (buf) {
      onProgress(88, 'Encoding…');
      return AudioSaw.encode(buf, AudioSaw.resolveFormat(opts.fmt, opts.bitrate), {
        bitrate: AudioSaw.bitrateOf(opts.bitrate), srcInfo: srcInfo
      });
    }).then(function (blob) {
      onProgress(95, 'Finishing…');
      var sign = semitones > 0 ? '+' : '';
      return {
        name: AudioSaw.rename(file.name, opts.fmt)
          .replace(/\.([^.]+)$/, '-' + sign + semitones + 'st.$1'),
        blob: blob
      };
    });
  }

  // The sample rate from ffmpeg's stream report, for files whose header the
  // sniffer does not know. 44.1 kHz only if even that fails.
  function probeRate(file, ext) {
    return AudioSaw.ensureFFmpeg().then(function (pack) {
      var ffmpeg = pack.ffmpeg, rate = 0, inName = 'probe_' + Date.now() + '.' + ext;
      function onLog(e) {
        var m = /(\d{4,6}) Hz/.exec((e && e.message) || '');
        if (m && !rate) rate = parseInt(m[1], 10);
      }
      return pack.util.fetchFile(file).then(function (data) {
        return ffmpeg.writeFile(inName, data);
      }).then(function () {
        ffmpeg.on('log', onLog);
        return ffmpeg.exec(['-i', inName, '-t', '0.1', '-f', 'null', '-']).catch(function () {});
      }).then(function () {
        try { ffmpeg.off('log', onLog); } catch (e) { /* older API */ }
        try { ffmpeg.deleteFile(inName); } catch (e) {}
        return rate || 44100;
      });
    });
  }

  // With the song's key known, say which key each shift lands in. The key
  // arrives from /key-finder as ?key=A-minor.
  var K = window.ASKey, keySel = CV.$('#songKey'), semSel = CV.$('#semitones'), note = CV.$('#keyShiftNote');
  function keyNote() {
    var key = K && K.parse(keySel.value);
    if (!key) { note.innerHTML = 'Not sure of the key? <button type="button" class="btn btn-small btn-secondary" data-detect-key>Detect it from this file</button>'; return; }
    var to = K.transpose(key, parseInt(semSel.value, 10) || 0);
    note.textContent = key.name + ' (' + key.camelot + ') → ' + to.name + ' (' + to.camelot + ')';
  }
  if (K && keySel) {
    var fromUrl = K.parse(decodeURIComponent((location.search.match(/[?&]key=([^&]+)/) || [])[1] || ''));
    if (fromUrl) keySel.value = fromUrl.name.replace(' ', '-');
    keySel.addEventListener('change', keyNote);
    semSel.addEventListener('change', keyNote);
    keyNote();
    // The editor's project key, when "Use project audio" is taken.
    document.addEventListener('as:project-key', function (e) {
      var k = e.detail.key;
      if (k) { keySel.value = K.keyName(k.pc, k.mode).replace(' ', '-'); keyNote(); }
    });
    note.addEventListener('click', async function (e) {
      if (!e.target.hasAttribute('data-detect-key')) return;
      var files = shellApi && shellApi.files();
      if (!files || !files.length) return;
      note.textContent = 'Listening for the key…';
      try {
        var buf = await AudioSaw.decodeToAudioBuffer(files[0]), ch = [];
        for (var c = 0; c < buf.numberOfChannels; c++) ch.push(buf.getChannelData(c));
        var res = K.analyse(ch, buf.sampleRate);
        if (!res) { note.textContent = 'No key to read in that file.'; return; }
        keySel.value = res.name.replace(' ', '-');
        keyNote();
        if (res.confidence !== 'clear') note.textContent += ' — read from the file; it could also be ' + res.runnerUp.name + '.';
      } catch (err) { note.textContent = 'Could not read that file.'; }
    });
  }
  var shellApi = null;

  shellApi = CV.shell({
    accept: null,
    zipName: 'audiosaw-pitch.zip',
    failMessage: 'Could not shift the pitch. ',
    readOpts: function () {
      return {
        semitones: parseInt(CV.$('#semitones').value, 10),
        fmt: (CV.$('#outFmt').value || 'mp3').toLowerCase(),
        bitrate: CV.$('#bitrate').value
      };
    },
    process: process
  });
})();
