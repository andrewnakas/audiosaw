/*
 * Vocal remover / centre isolator.
 *
 * This is centre-channel cancellation, not machine-learning stem separation.
 * In most stereo mixes the lead vocal is panned dead centre, so it appears
 * identically in both channels. Subtracting one channel from the other cancels
 * anything common to both and leaves what was panned to the sides.
 *
 *   side = (L - R) / 2     everything NOT in the centre  -> instrumental
 *   mid  = (L + R) / 2     everything in the centre      -> vocal-ish
 *
 * The naive version has a well-known problem: kick, bass and snare are usually
 * centred too, so a plain L-R strips the low end out of the backing track and
 * leaves it thin. The fix is a band split — keep the mid signal below a
 * crossover (default 200 Hz) and only cancel the centre above it. That is the
 * difference between "this sounds broken" and "this is usable", and it is why
 * the crossover is exposed as a control.
 *
 * It cannot work on a mono file (there is no difference between the channels to
 * exploit), and it degrades on mixes with heavy stereo reverb on the vocal or
 * with instruments also panned centre. The page says so.
 */
(function () {
  'use strict';

  function process(file, opts, onProgress) {
    onProgress(5, 'Decoding…');
    return AudioSaw.decodeToAudioBuffer(file).then(function (buf) {
      if (buf.numberOfChannels < 2) {
        throw new Error('This file is mono. Centre cancellation needs a stereo mix — there is no channel difference to work with.');
      }
      onProgress(30, opts.mode === 'acapella' ? 'Isolating the centre…' : 'Cancelling the centre…');

      var L = buf.getChannelData(0);
      var R = buf.getChannelData(1);
      var n = buf.length;
      var sr = buf.sampleRate;

      var mid = new Float32Array(n);
      var side = new Float32Array(n);
      for (var i = 0; i < n; i++) {
        mid[i] = (L[i] + R[i]) / 2;
        side[i] = (L[i] - R[i]) / 2;
      }

      // Split the mid signal at the crossover so the parts that are centred but
      // not vocal (kick, bass) can be handled separately. The filter has to be
      // steep — a gentle slope leaks the vocal back in along with the bass,
      // which defeats the point.
      var outL = new Float32Array(n);
      var outR = new Float32Array(n);

      if (opts.mode === 'acapella') {
        // Keep the centre, drop the sides, and high-pass away the low band so
        // the result is the vocal rather than the vocal plus kick and bass.
        var voice = opts.crossover > 0 ? CV.highpass(mid, sr, opts.crossover, 2) : mid;
        for (var j = 0; j < n; j++) {
          outL[j] = voice[j];
          outR[j] = voice[j];
        }
      } else {
        // Instrumental: the sides, plus the low band of the mid put back so the
        // track keeps its bottom end. Re-widened so it is not bare mono.
        var midLow = opts.crossover > 0 ? CV.lowpass(mid, sr, opts.crossover, 2) : null;
        for (var k = 0; k < n; k++) {
          var low = midLow ? midLow[k] : 0;
          outL[k] = side[k] + low;
          outR[k] = -side[k] + low;
        }
      }

      onProgress(60, 'Levelling…');
      // Cancellation usually drops the level a long way; bring it back so the
      // result is comparable to the source rather than mysteriously quiet.
      if (opts.normalise) CV.peakNormalise([outL, outR], 0.97);
      // Without levelling, the re-widened sides can pass full scale: limit
      // to -1 dBTP rather than let the encoder clip.
      else if (window.ASLoudness && ASLoudness.truePeak([outL, outR]) > 1) ASLoudness.limit([outL, outR], sr, Math.pow(10, -1 / 20));

      var outBuf = CV.bufferFrom([outL, outR], sr);
      onProgress(70, 'Encoding…');
      return CV.encodeBuffer(outBuf, opts.fmt, opts.bitrate, function (pct) {
        onProgress(70 + pct * 0.3);
      }).then(function (blob) {
        var suffix = opts.mode === 'acapella' ? '-acapella' : '-instrumental';
        return { name: AudioSaw.rename(file.name, opts.fmt).replace(/\.([^.]+)$/, suffix + '.$1'), blob: blob };
      });
    });
  }

  CV.shell({
    accept: null,
    zipName: 'audiosaw-vocal-remover.zip',
    failMessage: 'Could not process that file. ',
    readOpts: function () {
      return {
        mode: CV.$('#mode').value,
        crossover: parseInt(CV.$('#crossover').value, 10),
        normalise: CV.$('#normalise').value === 'yes',
        fmt: (CV.$('#outFmt').value || 'mp3').toLowerCase(),
        bitrate: CV.$('#bitrate').value
      };
    },
    process: process
  });
})();
