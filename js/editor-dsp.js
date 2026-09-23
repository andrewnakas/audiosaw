/*
 * The audio editor's real-time effects: the plugin catalogue and the code that
 * builds each plugin as a Web Audio graph.
 *
 * Everything the UI needs to know about a plugin is declared here and nowhere
 * else: its parameters (range, unit, scale, group), its smart controls (a few
 * plain-words knobs that each drive several parameters along a curve), its
 * factory presets, which parameters change the shape of the graph rather than
 * a value in it, and how long a tail it leaves. The patches — whole chains in
 * one tap — are declared here too, against the same parameter names, and
 * tools/check-editor.js checks every preset and patch names real parameters
 * inside their ranges.
 *
 * The declarations are plain data and run in Node. The builders only run in a
 * browser, and the same builder serves live playback and the offline export,
 * so what you hear is what gets written.
 *
 * Things that bit, and why the code is the way it is:
 *
 *  - BiquadFilterNode reads Q in dB for lowpass and highpass, not as a ratio.
 *    A Butterworth section is Q 0.7071, which is -3.01 "dB"; passing 0.7071
 *    gives a 2.6 dB resonant bump. qdb() does the conversion, and response()
 *    follows the same rule so the drawn curve is the heard one.
 *  - DynamicsCompressorNode adds make-up gain it does not report: a 1 kHz tone
 *    10 dB over a -20 dB threshold at 4:1 should leave at -17.5 dBFS and
 *    measured -8.2 in Chrome. It also has a fixed look-ahead delay, which
 *    combs a parallel mix. The dynamics here are an AudioWorklet instead.
 *  - WaveShaperNode clamps its input to [-1, 1] before the curve. Drive is
 *    built into the curve (f(k·x)), never applied as a gain in front of it, or
 *    every "soft" type turns into a hard clipper.
 *  - A feedback loop in Web Audio is silent unless it contains a DelayNode.
 *    The phaser's feedback path has one for that reason.
 *  - Worklet parameters are passed as parameterData at construction. A port
 *    message sent straight after would arrive after an OfflineAudioContext
 *    has already rendered the first blocks with the defaults.
 *  - The reverb's impulse response comes from a seeded generator, so the same
 *    settings give the same reverb in playback, in the export and in tests.
 */
(function (global) {
  'use strict';

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function dbToGain(db) { return Math.pow(10, db / 20); }
  function qdb(q) { return 20 * Math.log10(q); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function logLerp(a, b, t) { return a * Math.pow(b / a, t); }

  /* ------------------------------------------------------------ params */

  // P(key, label, min, max, default, unit, extra)
  //   extra.log     logarithmic slider (frequencies, times)
  //   extra.step    slider resolution
  //   extra.opts    enum: [[value, label], ...]; min/max ignored
  //   extra.group   heading it sits under in "Show all controls"
  //   extra.hint    plain-words explanation shown under the label
  //   extra.kind    'track' — the options are the project's tracks
  function P(k, label, min, max, def, unit, extra) {
    var p = { k: k, label: label, min: min, max: max, def: def, unit: unit || '' };
    if (extra) Object.keys(extra).forEach(function (x) { p[x] = extra[x]; });
    if (p.opts) p.enumType = true;
    return p;
  }
  function E(k, label, opts, def, extra) { return P(k, label, 0, 0, def, '', Object.assign({ opts: opts }, extra || {})); }

  var ONOFF = [['off', 'Off'], ['on', 'On']];
  var SLOPES = [['12', '12 dB/oct'], ['24', '24 dB/oct'], ['48', '48 dB/oct']];
  var SHAPES = [['sine', 'Sine'], ['triangle', 'Triangle'], ['square', 'Square'], ['sawtooth', 'Saw']];
  var SYNC = [['off', 'Free (Hz / ms)'], ['1/1', '1 bar'], ['1/2', '1/2'], ['1/2D', '1/2 dotted'], ['1/4', '1/4'], ['1/4D', '1/4 dotted'], ['1/4T', '1/4 triplet'],
    ['1/8', '1/8'], ['1/8D', '1/8 dotted'], ['1/8T', '1/8 triplet'], ['1/16', '1/16'], ['1/16D', '1/16 dotted'], ['1/16T', '1/16 triplet'], ['1/32', '1/32']];

  // Seconds in one note value at a tempo.
  function noteSec(note, bpm) {
    var m = /^1\/(\d+)([DT]?)$/.exec(note || '');
    if (!m) return null;
    var s = (60 / (bpm || 120)) * 4 / +m[1];
    if (m[2] === 'D') s *= 1.5;
    if (m[2] === 'T') s *= 2 / 3;
    return s;
  }

  /* --------------------------------------------------------- catalogue */

  var CATS = [
    ['eq', 'EQ & filter'], ['dyn', 'Dynamics'], ['colour', 'Colour'],
    ['mod', 'Modulation'], ['time', 'Delay & reverb'], ['util', 'Pitch & utility']
  ];

  var PLUGINS = {};

  PLUGINS.eq = {
    name: 'Channel EQ', cat: 'eq',
    desc: 'Cut or boost any part of the sound: low cut, two shelves, four bands and a high cut.',
    params: [
      E('hpOn', 'Low cut', ONOFF, 'off', { group: 'Low cut', hint: 'Removes rumble and boom below the frequency' }),
      P('hpFreq', 'Low cut frequency', 20, 1000, 80, 'Hz', { log: true, group: 'Low cut' }),
      E('hpSlope', 'Low cut slope', SLOPES, '24', { group: 'Low cut' }),
      P('lsFreq', 'Low shelf frequency', 20, 1000, 100, 'Hz', { log: true, group: 'Low shelf' }),
      P('lsGain', 'Low shelf', -24, 24, 0, 'dB', { step: 0.1, group: 'Low shelf' }),
      P('p1Freq', 'Band 1 frequency', 20, 20000, 250, 'Hz', { log: true, group: 'Band 1' }),
      P('p1Gain', 'Band 1 gain', -24, 24, 0, 'dB', { step: 0.1, group: 'Band 1' }),
      P('p1Q', 'Band 1 Q', 0.1, 12, 1, '', { log: true, step: 0.01, group: 'Band 1', hint: 'Higher is narrower' }),
      P('p2Freq', 'Band 2 frequency', 20, 20000, 800, 'Hz', { log: true, group: 'Band 2' }),
      P('p2Gain', 'Band 2 gain', -24, 24, 0, 'dB', { step: 0.1, group: 'Band 2' }),
      P('p2Q', 'Band 2 Q', 0.1, 12, 1, '', { log: true, step: 0.01, group: 'Band 2' }),
      P('p3Freq', 'Band 3 frequency', 20, 20000, 3000, 'Hz', { log: true, group: 'Band 3' }),
      P('p3Gain', 'Band 3 gain', -24, 24, 0, 'dB', { step: 0.1, group: 'Band 3' }),
      P('p3Q', 'Band 3 Q', 0.1, 12, 1, '', { log: true, step: 0.01, group: 'Band 3' }),
      P('p4Freq', 'Band 4 frequency', 20, 20000, 8000, 'Hz', { log: true, group: 'Band 4' }),
      P('p4Gain', 'Band 4 gain', -24, 24, 0, 'dB', { step: 0.1, group: 'Band 4' }),
      P('p4Q', 'Band 4 Q', 0.1, 12, 1, '', { log: true, step: 0.01, group: 'Band 4' }),
      P('hsFreq', 'High shelf frequency', 1000, 20000, 10000, 'Hz', { log: true, group: 'High shelf' }),
      P('hsGain', 'High shelf', -24, 24, 0, 'dB', { step: 0.1, group: 'High shelf' }),
      E('lpOn', 'High cut', ONOFF, 'off', { group: 'High cut', hint: 'Removes hiss and harshness above the frequency' }),
      P('lpFreq', 'High cut frequency', 1000, 20000, 16000, 'Hz', { log: true, group: 'High cut' }),
      E('lpSlope', 'High cut slope', SLOPES, '24', { group: 'High cut' })
    ],
    structural: ['hpOn', 'hpSlope', 'lpOn', 'lpSlope'],
    macros: [
      { k: 'bass', label: 'Bass', def: 0.5, fmt: sdb(-12, 12), map: function (v) { return { lsFreq: 110, lsGain: r1(lerp(-12, 12, v)) }; } },
      { k: 'mud', label: 'Clear the mud', def: 0, fmt: pct, map: function (v) { return { p1Freq: 300, p1Q: 1.2, p1Gain: r1(-9 * v) }; } },
      { k: 'presence', label: 'Presence', def: 0.5, fmt: sdb(-9, 9), map: function (v) { return { p3Freq: 3200, p3Q: 0.9, p3Gain: r1(lerp(-9, 9, v)) }; } },
      { k: 'air', label: 'Air', def: 0.5, fmt: sdb(-9, 9), map: function (v) { return { hsFreq: 11000, hsGain: r1(lerp(-9, 9, v)) }; } }
    ],
    presets: [
      { name: 'Vocal clarity', p: { hpOn: 'on', hpFreq: 90, p1Freq: 300, p1Gain: -3, p1Q: 1.2, p3Freq: 3200, p3Gain: 3.5, p3Q: 0.9, hsFreq: 11000, hsGain: 2.5 } },
      { name: 'Podcast voice', p: { hpOn: 'on', hpFreq: 80, lsFreq: 180, lsGain: -2, p2Freq: 450, p2Gain: -2.5, p2Q: 1.4, p3Freq: 3500, p3Gain: 3, p3Q: 0.8 } },
      { name: 'Kick punch', p: { hpOn: 'on', hpFreq: 30, p1Freq: 60, p1Gain: 4, p1Q: 1.3, p2Freq: 350, p2Gain: -5, p2Q: 1.5, p3Freq: 3500, p3Gain: 3, p3Q: 1.4 } },
      { name: 'Telephone', p: { hpOn: 'on', hpFreq: 400, hpSlope: '48', lpOn: 'on', lpFreq: 3200, lpSlope: '48', p2Freq: 1500, p2Gain: 6, p2Q: 0.9 } },
      { name: 'Bright acoustic', p: { hpOn: 'on', hpFreq: 70, p1Freq: 220, p1Gain: -2.5, hsFreq: 9000, hsGain: 4 } },
      { name: 'Warm it up', p: { lsFreq: 160, lsGain: 3, hsFreq: 7000, hsGain: -3 } }
    ],
    build: buildEq
  };

  PLUGINS.filter = {
    name: 'Filter', cat: 'eq', mix: 'linear', mixDef: 100,
    desc: 'A resonant filter that can sweep by itself — for DJ-style sweeps, wobbles and muffled builds.',
    params: [
      E('type', 'Type', [['lowpass', 'Low-pass'], ['highpass', 'High-pass'], ['bandpass', 'Band-pass'], ['notch', 'Notch']], 'lowpass', { group: 'Filter' }),
      P('freq', 'Cutoff', 20, 20000, 1200, 'Hz', { log: true, group: 'Filter' }),
      P('res', 'Resonance', 0, 24, 6, 'dB', { step: 0.1, group: 'Filter', hint: 'A peak at the cutoff; high values whistle' }),
      E('sync', 'LFO speed', SYNC, 'off', { group: 'Movement' }),
      P('rate', 'LFO rate', 0.05, 20, 0.5, 'Hz', { log: true, step: 0.01, group: 'Movement' }),
      P('depth', 'LFO depth', 0, 100, 0, '%', { group: 'Movement', hint: 'How far the cutoff sweeps, up to four octaves' }),
      E('shape', 'LFO shape', SHAPES, 'sine', { group: 'Movement' })
    ],
    structural: [],
    macros: [
      { k: 'cutoff', label: 'Cutoff', def: 0.66, fmt: function (v) { return fmtHz(logLerp(40, 18000, v)); }, map: function (v) { return { freq: Math.round(logLerp(40, 18000, v)) }; } },
      { k: 'res', label: 'Resonance', def: 0.25, fmt: pct, map: function (v) { return { res: r1(v * 24) }; } },
      { k: 'wobble', label: 'Wobble', def: 0, fmt: pct, map: function (v) { return { depth: Math.round(v * 70), rate: r2(lerp(0.2, 6, v * v)) }; } }
    ],
    presets: [
      { name: 'Muffled (next room)', p: { type: 'lowpass', freq: 500, res: 2 } },
      { name: 'Slow sweep', p: { type: 'lowpass', freq: 900, res: 8, sync: '1/1', depth: 55, shape: 'triangle' } },
      { name: 'Dubstep wobble', p: { type: 'lowpass', freq: 600, res: 12, sync: '1/8', depth: 70, shape: 'sine' } },
      { name: 'Thin it out', p: { type: 'highpass', freq: 600, res: 3 } },
      { name: 'Radio band', p: { type: 'bandpass', freq: 1400, res: 4 } }
    ],
    build: buildFilter
  };

  PLUGINS.exciter = {
    name: 'Exciter', cat: 'eq',
    desc: 'Adds fresh high harmonics so a dull recording sounds brighter without turning up the hiss.',
    params: [
      P('freq', 'Frequency', 1000, 12000, 3500, 'Hz', { log: true, hint: 'Only sound above this is excited' }),
      P('drive', 'Drive', 0, 36, 14, 'dB'),
      P('amount', 'Amount', 0, 100, 30, '%')
    ],
    structural: [],
    macros: [
      { k: 'amount', label: 'Amount', def: 0.3, fmt: pct, map: function (v) { return { amount: Math.round(v * 100) }; } },
      { k: 'tone', label: 'Focus', def: 0.45, fmt: function (v) { return fmtHz(logLerp(1500, 10000, v)); }, map: function (v) { return { freq: Math.round(logLerp(1500, 10000, v)) }; } }
    ],
    presets: [
      { name: 'Subtle sparkle', p: { freq: 6000, drive: 10, amount: 20 } },
      { name: 'Vocal presence', p: { freq: 3000, drive: 16, amount: 35 } },
      { name: 'Dull recording rescue', p: { freq: 2500, drive: 20, amount: 55 } }
    ],
    build: buildExciter
  };

  PLUGINS.comp = {
    name: 'Compressor', cat: 'dyn', mix: 'linear', mixDef: 100, meter: 'gr',
    desc: 'Evens out loud and quiet moments. Mix below 100% is parallel compression.',
    params: [
      P('thresh', 'Threshold', -60, 0, -18, 'dB', { step: 0.1, group: 'Compression', hint: 'Sound louder than this gets turned down' }),
      P('ratio', 'Ratio', 1, 20, 3, ':1', { log: true, step: 0.1, group: 'Compression', hint: 'How hard: 2:1 is gentle, 10:1 is squashed' }),
      P('knee', 'Knee', 0, 24, 6, 'dB', { step: 0.1, group: 'Compression', hint: 'Soft knee eases in' }),
      P('attack', 'Attack', 0.1, 200, 10, 'ms', { log: true, step: 0.1, group: 'Timing', hint: 'Slower lets the start of each hit through' }),
      P('release', 'Release', 5, 2000, 150, 'ms', { log: true, group: 'Timing' }),
      E('detect', 'Detection', [['peak', 'Peak'], ['rms', 'RMS (smoother)']], 'peak', { group: 'Timing' }),
      P('scHp', 'Sidechain low cut', 0, 500, 0, 'Hz', { group: 'Sidechain', hint: 'Stops bass from triggering it. 0 is off' }),
      E('auto', 'Auto make-up', ONOFF, 'on', { group: 'Output', hint: 'Turns it back up by the average reduction' }),
      P('makeup', 'Make-up gain', 0, 30, 0, 'dB', { step: 0.1, group: 'Output' })
    ],
    structural: [],
    macros: [
      { k: 'amount', label: 'Amount', def: 0.35, fmt: pct, map: function (v) { return { thresh: r1(lerp(-4, -42, v)), ratio: r1(lerp(1.5, 8, v * v)) }; } },
      { k: 'speed', label: 'Speed', def: 0.5, fmt: function (v) { return v < 0.34 ? 'slow' : v < 0.67 ? 'medium' : 'fast'; }, map: function (v) { return { attack: r1(logLerp(40, 0.5, v)), release: Math.round(logLerp(400, 50, v)) }; } }
    ],
    presets: [
      { name: 'Gentle glue', p: { thresh: -14, ratio: 2, knee: 10, attack: 30, release: 250 } },
      { name: 'Vocal leveller', p: { thresh: -22, ratio: 3.5, knee: 8, attack: 6, release: 120, scHp: 100, detect: 'rms' } },
      { name: 'Podcast', p: { thresh: -24, ratio: 4, knee: 6, attack: 5, release: 150, scHp: 80 } },
      { name: 'Punchy drums', p: { thresh: -20, ratio: 4, knee: 2, attack: 25, release: 90 } },
      { name: 'New York (parallel)', p: { thresh: -35, ratio: 10, knee: 0, attack: 1, release: 80, mix: 40 } },
      { name: 'Bass steady', p: { thresh: -20, ratio: 5, knee: 4, attack: 15, release: 180, detect: 'rms' } }
    ],
    build: buildComp
  };

  PLUGINS.limiter = {
    name: 'Limiter', cat: 'dyn', meter: 'gr', latency: LIM_LATENCY,
    desc: 'A brick wall: nothing gets past the ceiling, including peaks between samples. Push the gain for loudness.',
    params: [
      P('gain', 'Gain', 0, 24, 0, 'dB', { step: 0.1, hint: 'Pushes the level into the ceiling' }),
      P('ceiling', 'Ceiling', -12, 0, -1, 'dBTP', { step: 0.1, hint: 'Streaming services ask for -1' }),
      P('release', 'Release', 1, 1000, 80, 'ms', { log: true })
    ],
    structural: [],
    macros: [
      { k: 'loud', label: 'Loudness', def: 0, fmt: function (v) { return '+' + (v * 12).toFixed(1) + ' dB'; }, map: function (v) { return { gain: r1(v * 12) }; } }
    ],
    presets: [
      { name: 'Safety (-1 dBTP)', p: { gain: 0, ceiling: -1, release: 80 } },
      { name: 'Streaming loud', p: { gain: 6, ceiling: -1, release: 60 } },
      { name: 'Broadcast (-2 dBTP)', p: { gain: 3, ceiling: -2, release: 120 } }
    ],
    build: buildLimiter
  };

  PLUGINS.gate = {
    name: 'Noise gate', cat: 'dyn', meter: 'gr',
    desc: 'Silences the gaps: closes when the sound drops below the threshold, so hum and room noise vanish between phrases.',
    params: [
      P('thresh', 'Threshold', -80, 0, -45, 'dB', { step: 0.1, hint: 'Sound quieter than this is shut off' }),
      P('range', 'Reduction', 0, 80, 40, 'dB', { hint: 'How far it closes. Less sounds more natural' }),
      P('attack', 'Attack', 0.1, 50, 1, 'ms', { log: true, step: 0.1 }),
      P('hold', 'Hold', 0, 500, 40, 'ms'),
      P('release', 'Release', 5, 2000, 120, 'ms', { log: true }),
      P('scHp', 'Sidechain low cut', 0, 500, 0, 'Hz', { hint: 'Stops low rumble opening the gate. 0 is off' })
    ],
    structural: [],
    macros: [
      { k: 'thresh', label: 'Threshold', def: 0.44, fmt: function (v) { return Math.round(lerp(-80, -10, v)) + ' dB'; }, map: function (v) { return { thresh: r1(lerp(-80, -10, v)) }; } },
      { k: 'depth', label: 'Depth', def: 0.5, fmt: function (v) { return Math.round(lerp(6, 80, v)) + ' dB'; }, map: function (v) { return { range: Math.round(lerp(6, 80, v)) }; } }
    ],
    presets: [
      { name: 'Voice (gentle)', p: { thresh: -48, range: 15, attack: 2, hold: 80, release: 200, scHp: 80 } },
      { name: 'Drum tight', p: { thresh: -30, range: 60, attack: 0.3, hold: 20, release: 60 } },
      { name: 'Hum killer', p: { thresh: -50, range: 40, attack: 1, hold: 60, release: 150, scHp: 150 } }
    ],
    build: buildGate
  };

  PLUGINS.deess = {
    name: 'De-esser', cat: 'dyn', meter: 'gr',
    desc: 'Tames harsh “s” and “t” sounds by turning down only the top end, only when it spikes.',
    params: [
      P('freq', 'Frequency', 2000, 12000, 6000, 'Hz', { log: true, hint: 'Where the esses sit: lower for deep voices' }),
      P('thresh', 'Threshold', -60, 0, -30, 'dB', { step: 0.1 }),
      P('range', 'Max reduction', 0, 24, 10, 'dB', { step: 0.1 })
    ],
    structural: [],
    macros: [
      { k: 'amount', label: 'Amount', def: 0.4, fmt: pct, map: function (v) { return { thresh: r1(lerp(-12, -50, v)), range: r1(lerp(4, 16, v)) }; } }
    ],
    presets: [
      { name: 'Female voice', p: { freq: 7500, thresh: -30, range: 10 } },
      { name: 'Male voice', p: { freq: 5500, thresh: -30, range: 10 } },
      { name: 'Heavy', p: { freq: 6000, thresh: -42, range: 16 } }
    ],
    build: buildDeess
  };

  PLUGINS.multiband = {
    name: 'Multiband compressor', cat: 'dyn', meter: 'gr',
    desc: 'Three compressors, one each for lows, mids and highs, so a boomy bass note no longer pushes the vocal down.',
    params: [
      P('x1', 'Low / mid split', 40, 1000, 200, 'Hz', { log: true, group: 'Crossovers' }),
      P('x2', 'Mid / high split', 1000, 12000, 3000, 'Hz', { log: true, group: 'Crossovers' }),
      P('lThresh', 'Low threshold', -60, 0, -20, 'dB', { step: 0.1, group: 'Low' }),
      P('lRatio', 'Low ratio', 1, 20, 3, ':1', { log: true, step: 0.1, group: 'Low' }),
      P('lGain', 'Low gain', -12, 12, 0, 'dB', { step: 0.1, group: 'Low' }),
      P('mThresh', 'Mid threshold', -60, 0, -20, 'dB', { step: 0.1, group: 'Mid' }),
      P('mRatio', 'Mid ratio', 1, 20, 2.5, ':1', { log: true, step: 0.1, group: 'Mid' }),
      P('mGain', 'Mid gain', -12, 12, 0, 'dB', { step: 0.1, group: 'Mid' }),
      P('hThresh', 'High threshold', -60, 0, -22, 'dB', { step: 0.1, group: 'High' }),
      P('hRatio', 'High ratio', 1, 20, 2.5, ':1', { log: true, step: 0.1, group: 'High' }),
      P('hGain', 'High gain', -12, 12, 0, 'dB', { step: 0.1, group: 'High' }),
      P('attack', 'Attack', 0.1, 200, 10, 'ms', { log: true, step: 0.1, group: 'Timing' }),
      P('release', 'Release', 5, 2000, 150, 'ms', { log: true, group: 'Timing' })
    ],
    structural: [],
    macros: [
      { k: 'amount', label: 'Squash', def: 0.35, fmt: pct, map: function (v) {
        var t = r1(lerp(-6, -40, v)), r = r1(lerp(1.5, 6, v * v));
        return { lThresh: t, mThresh: t, hThresh: r1(t - 2), lRatio: r, mRatio: r1(r * 0.85), hRatio: r1(r * 0.85) };
      } },
      { k: 'low', label: 'Low', def: 0.5, fmt: sdb(-8, 8), map: function (v) { return { lGain: r1(lerp(-8, 8, v)) }; } },
      { k: 'high', label: 'High', def: 0.5, fmt: sdb(-8, 8), map: function (v) { return { hGain: r1(lerp(-8, 8, v)) }; } }
    ],
    presets: [
      { name: 'Master glue', p: { lThresh: -18, lRatio: 2, mThresh: -16, mRatio: 1.8, hThresh: -20, hRatio: 2, attack: 20, release: 200 } },
      { name: 'Tame the boom', p: { x1: 180, lThresh: -28, lRatio: 5, mThresh: -10, mRatio: 1.2, hThresh: -10, hRatio: 1.2 } },
      { name: 'Broadcast voice', p: { x1: 150, x2: 4000, lThresh: -30, lRatio: 4, mThresh: -24, mRatio: 3, hThresh: -30, hRatio: 3, mGain: 2 } }
    ],
    build: buildMultiband
  };

  PLUGINS.transient = {
    name: 'Transient shaper', cat: 'dyn',
    desc: 'Makes hits snappier or softer, and rooms longer or tighter, without touching the overall level.',
    params: [
      P('attack', 'Attack', -100, 100, 0, '%', { hint: 'Up for snap, down to soften hits' }),
      P('sustain', 'Sustain', -100, 100, 0, '%', { hint: 'Up for more room, down for tighter' })
    ],
    structural: [],
    macros: [
      { k: 'punch', label: 'Punch', def: 0.5, fmt: spct, map: function (v) { return { attack: Math.round(lerp(-100, 100, v)) }; } },
      { k: 'body', label: 'Body', def: 0.5, fmt: spct, map: function (v) { return { sustain: Math.round(lerp(-100, 100, v)) }; } }
    ],
    presets: [
      { name: 'Snappy drums', p: { attack: 60, sustain: -20 } },
      { name: 'Tighten the room', p: { attack: 0, sustain: -60 } },
      { name: 'Soften plucks', p: { attack: -50, sustain: 20 } }
    ],
    build: buildTransient
  };

  PLUGINS.ducker = {
    name: 'Ducker (sidechain)', cat: 'dyn', meter: 'gr',
    desc: 'Turns this track down whenever another track plays — music under a voice, or the pumping of EDM bass against the kick.',
    params: [
      E('src', 'Listen to', [], '', { kind: 'track', hint: 'The track whose sound pushes this one down' }),
      P('range', 'Amount', 0, 40, 12, 'dB', { step: 0.1 }),
      P('thresh', 'Threshold', -60, 0, -35, 'dB', { step: 0.1 }),
      P('attack', 'Attack', 0.1, 200, 8, 'ms', { log: true, step: 0.1 }),
      P('hold', 'Hold', 0, 1000, 60, 'ms'),
      P('release', 'Release', 10, 3000, 350, 'ms', { log: true })
    ],
    structural: ['src'],
    macros: [
      { k: 'amount', label: 'Amount', def: 0.3, fmt: function (v) { return Math.round(v * 40) + ' dB'; }, map: function (v) { return { range: r1(v * 40) }; } },
      { k: 'speed', label: 'Recovery', def: 0.5, fmt: function (v) { return v < 0.34 ? 'fast' : v < 0.67 ? 'medium' : 'slow'; }, map: function (v) { return { release: Math.round(logLerp(80, 1500, v)) }; } }
    ],
    presets: [
      { name: 'Music under voice', p: { range: 14, thresh: -40, attack: 20, hold: 250, release: 700 } },
      { name: 'EDM pump', p: { range: 24, thresh: -30, attack: 1, hold: 0, release: 180 } },
      { name: 'Gentle dip', p: { range: 6, thresh: -40, attack: 30, hold: 150, release: 600 } }
    ],
    build: buildDucker
  };

  PLUGINS.drive = {
    name: 'Drive', cat: 'colour', mix: 'linear', mixDef: 100,
    desc: 'Saturation and distortion, from a warm tube glow to a broken fuzz pedal.',
    params: [
      E('type', 'Character', [['soft', 'Soft clip'], ['tube', 'Tube'], ['tape', 'Tape'], ['hard', 'Hard clip'], ['fuzz', 'Fuzz'], ['fold', 'Wavefolder']], 'tube'),
      P('drive', 'Drive', 0, 48, 12, 'dB'),
      P('bias', 'Asymmetry', 0, 100, 20, '%', { hint: 'Adds the even harmonics that make tubes sound warm' }),
      P('tone', 'Tone', 500, 20000, 9000, 'Hz', { log: true, hint: 'Rolls off the fizz' }),
      E('auto', 'Keep the level', ONOFF, 'on', { hint: 'Turns the output down as the drive goes up' })
    ],
    structural: [],
    macros: [
      { k: 'drive', label: 'Drive', def: 0.25, fmt: function (v) { return (v * 48).toFixed(0) + ' dB'; }, map: function (v) { return { drive: r1(v * 48) }; } },
      { k: 'tone', label: 'Tone', def: 0.72, fmt: function (v) { return fmtHz(logLerp(800, 20000, v)); }, map: function (v) { return { tone: Math.round(logLerp(800, 20000, v)) }; } }
    ],
    presets: [
      { name: 'Warm tube', p: { type: 'tube', drive: 8, bias: 30, tone: 12000 } },
      { name: 'Crunchy', p: { type: 'soft', drive: 24, bias: 10, tone: 7000 } },
      { name: 'Fuzz pedal', p: { type: 'fuzz', drive: 36, bias: 50, tone: 5000 } },
      { name: 'Parallel grit', p: { type: 'hard', drive: 30, tone: 6000, mix: 30 } },
      { name: 'Wavefold synth', p: { type: 'fold', drive: 18, bias: 0, tone: 14000 } }
    ],
    build: buildDrive
  };

  PLUGINS.crush = {
    name: 'Bitcrusher', cat: 'colour', mix: 'linear', mixDef: 100,
    desc: 'Lo-fi digital grit: fewer bits and a lower sample rate, like an early sampler or a video game.',
    params: [
      P('bits', 'Bit depth', 1, 24, 8, 'bits', { step: 1 }),
      P('down', 'Downsample', 1, 64, 4, '×', { log: true, step: 1, hint: 'Divides the sample rate' })
    ],
    structural: [],
    macros: [
      { k: 'crunch', label: 'Crunch', def: 0.4, fmt: pct, map: function (v) { return { bits: Math.round(lerp(16, 3, v)), down: Math.max(1, Math.round(logLerp(1, 40, v))) }; } }
    ],
    presets: [
      { name: '12-bit sampler', p: { bits: 12, down: 2 } },
      { name: '8-bit console', p: { bits: 8, down: 6 } },
      { name: 'Destroyed', p: { bits: 4, down: 20 } }
    ],
    build: buildCrush
  };

  PLUGINS.tape = {
    name: 'Tape', cat: 'colour',
    desc: 'Tape machine colour: soft saturation, a low-end bump, rolled-off highs and the slow wobble of a worn cassette.',
    params: [
      P('drive', 'Saturation', 0, 24, 6, 'dB'),
      P('bump', 'Low bump', 0, 6, 2, 'dB', { step: 0.1 }),
      P('tone', 'High roll-off', 2000, 20000, 14000, 'Hz', { log: true }),
      P('wow', 'Wow', 0, 100, 10, '%', { hint: 'Slow pitch drift' }),
      P('flutter', 'Flutter', 0, 100, 10, '%', { hint: 'Fast pitch wobble' })
    ],
    structural: [],
    macros: [
      { k: 'age', label: 'Age', def: 0.2, fmt: pct, map: function (v) { return { wow: Math.round(v * 80), flutter: Math.round(v * 60), tone: Math.round(logLerp(18000, 4500, v)) }; } },
      { k: 'drive', label: 'Saturation', def: 0.25, fmt: function (v) { return (v * 24).toFixed(0) + ' dB'; }, map: function (v) { return { drive: r1(v * 24) }; } }
    ],
    presets: [
      { name: 'Studio 2-inch', p: { drive: 6, bump: 2, tone: 16000, wow: 3, flutter: 3 } },
      { name: 'Old cassette', p: { drive: 10, bump: 1, tone: 6000, wow: 45, flutter: 35 } },
      { name: 'Warped VHS', p: { drive: 8, bump: 0, tone: 4500, wow: 90, flutter: 60 } }
    ],
    build: buildTape
  };

  PLUGINS.chorus = {
    name: 'Chorus', cat: 'mod', mix: 'balance', mixDef: 50,
    desc: 'Thickens and widens by adding slightly detuned, slightly delayed copies.',
    params: [
      P('rate', 'Rate', 0.05, 5, 0.8, 'Hz', { log: true, step: 0.01 }),
      P('depth', 'Depth', 0, 10, 3, 'ms', { step: 0.1 }),
      P('delay', 'Delay', 5, 40, 14, 'ms', { step: 0.1 }),
      P('width', 'Width', 0, 100, 100, '%')
    ],
    structural: [],
    macros: [
      { k: 'depth', label: 'Depth', def: 0.3, fmt: pct, map: function (v) { return { depth: r1(v * 10) }; } },
      { k: 'rate', label: 'Speed', def: 0.4, fmt: function (v) { return logLerp(0.1, 4, v).toFixed(2) + ' Hz'; }, map: function (v) { return { rate: r2(logLerp(0.1, 4, v)) }; } }
    ],
    presets: [
      { name: 'Subtle doubler', p: { rate: 0.4, depth: 1.5, delay: 18, width: 100, mix: 35 } },
      { name: '80s guitar', p: { rate: 0.9, depth: 4, delay: 10, width: 100, mix: 50 } },
      { name: 'Seasick', p: { rate: 2.5, depth: 8, delay: 20, width: 60, mix: 60 } }
    ],
    build: buildChorus
  };

  PLUGINS.flanger = {
    name: 'Flanger', cat: 'mod', mix: 'linear', mixDef: 50,
    desc: 'The jet-plane whoosh: a very short delay swept up and down, fed back on itself.',
    params: [
      P('delay', 'Delay', 0.3, 10, 2, 'ms', { step: 0.1 }),
      P('depth', 'Depth', 0, 5, 1.5, 'ms', { step: 0.05 }),
      P('rate', 'Rate', 0.02, 5, 0.25, 'Hz', { log: true, step: 0.01 }),
      P('feedback', 'Feedback', -95, 95, 60, '%'),
      P('width', 'Stereo', 0, 100, 50, '%')
    ],
    structural: [],
    macros: [
      { k: 'intensity', label: 'Intensity', def: 0.6, fmt: pct, map: function (v) { return { feedback: Math.round(v * 92), depth: r2(lerp(0.5, 3, v)) }; } },
      { k: 'rate', label: 'Speed', def: 0.35, fmt: function (v) { return logLerp(0.05, 3, v).toFixed(2) + ' Hz'; }, map: function (v) { return { rate: r2(logLerp(0.05, 3, v)) }; } }
    ],
    presets: [
      { name: 'Jet', p: { delay: 1.5, depth: 2, rate: 0.12, feedback: 85, width: 30 } },
      { name: 'Metallic', p: { delay: 0.8, depth: 0.6, rate: 0.5, feedback: -80, width: 60 } },
      { name: 'Gentle swirl', p: { delay: 3, depth: 1, rate: 0.3, feedback: 30, width: 80, mix: 40 } }
    ],
    build: buildFlanger
  };

  PLUGINS.phaser = {
    name: 'Phaser', cat: 'mod', mix: 'linear', mixDef: 50,
    desc: 'A sweeping, hollow swirl from a chain of phase-shift stages — the classic 70s keyboard and guitar sound.',
    params: [
      E('stages', 'Stages', [['2', '2'], ['4', '4'], ['6', '6'], ['8', '8'], ['10', '10'], ['12', '12']], '6', { hint: 'More stages, more notches, stronger effect' }),
      E('sync', 'Speed', SYNC, 'off'),
      P('rate', 'Rate', 0.02, 8, 0.4, 'Hz', { log: true, step: 0.01 }),
      P('depth', 'Depth', 0, 100, 70, '%'),
      P('center', 'Centre', 100, 4000, 700, 'Hz', { log: true }),
      P('feedback', 'Feedback', 0, 90, 40, '%')
    ],
    structural: [],
    macros: [
      { k: 'intensity', label: 'Intensity', def: 0.5, fmt: pct, map: function (v) { return { depth: Math.round(lerp(30, 100, v)), feedback: Math.round(v * 80) }; } },
      { k: 'rate', label: 'Speed', def: 0.45, fmt: function (v) { return logLerp(0.05, 5, v).toFixed(2) + ' Hz'; }, map: function (v) { return { rate: r2(logLerp(0.05, 5, v)) }; } }
    ],
    presets: [
      { name: 'Slow swirl', p: { stages: '6', rate: 0.2, depth: 80, center: 600, feedback: 30 } },
      { name: 'Funky 4-stage', p: { stages: '4', rate: 0.8, depth: 70, center: 900, feedback: 50 } },
      { name: 'Deep 12-stage', p: { stages: '12', rate: 0.15, depth: 90, center: 500, feedback: 70 } }
    ],
    build: buildPhaser
  };

  PLUGINS.tremolo = {
    name: 'Tremolo', cat: 'mod',
    desc: 'Pulses the volume up and down, from a gentle shimmer to a hard, tempo-locked chop.',
    params: [
      E('sync', 'Speed', SYNC, '1/8'),
      P('rate', 'Rate', 0.1, 20, 5, 'Hz', { log: true, step: 0.01 }),
      P('depth', 'Depth', 0, 100, 60, '%'),
      E('shape', 'Shape', SHAPES, 'sine'),
      P('stereo', 'Stereo', 0, 100, 0, '%', { hint: '100% alternates left and right' })
    ],
    structural: [],
    macros: [
      { k: 'depth', label: 'Depth', def: 0.6, fmt: pct, map: function (v) { return { depth: Math.round(v * 100) }; } }
    ],
    presets: [
      { name: 'Surf amp', p: { sync: 'off', rate: 6, depth: 55, shape: 'sine' } },
      { name: 'Trance gate', p: { sync: '1/16', depth: 100, shape: 'square' } },
      { name: 'Stereo shimmer', p: { sync: '1/8T', depth: 45, shape: 'triangle', stereo: 100 } }
    ],
    build: buildTremolo
  };

  PLUGINS.autopan = {
    name: 'Auto-pan', cat: 'mod',
    desc: 'Moves the sound from left to right and back, on its own or in time with the song.',
    params: [
      E('sync', 'Speed', SYNC, '1/2'),
      P('rate', 'Rate', 0.02, 10, 0.5, 'Hz', { log: true, step: 0.01 }),
      P('depth', 'Width', 0, 100, 70, '%'),
      E('shape', 'Shape', SHAPES, 'sine')
    ],
    structural: [],
    macros: [
      { k: 'depth', label: 'Width', def: 0.7, fmt: pct, map: function (v) { return { depth: Math.round(v * 100) }; } }
    ],
    presets: [
      { name: 'Slow drift', p: { sync: 'off', rate: 0.15, depth: 60 } },
      { name: 'Ping-pong 8ths', p: { sync: '1/8', depth: 90, shape: 'square' } },
      { name: '8D audio', p: { sync: 'off', rate: 0.1, depth: 100, shape: 'sine' } }
    ],
    build: buildAutopan
  };

  PLUGINS.ring = {
    name: 'Ring modulator', cat: 'mod', mix: 'linear', mixDef: 100,
    desc: 'Multiplies the sound by a tone: metallic, bell-like, robotic. The Dalek voice.',
    params: [
      P('freq', 'Frequency', 1, 4000, 30, 'Hz', { log: true }),
      E('shape', 'Shape', SHAPES, 'sine')
    ],
    structural: [],
    macros: [
      { k: 'freq', label: 'Frequency', def: 0.4, fmt: function (v) { return fmtHz(logLerp(1, 4000, v)); }, map: function (v) { return { freq: r1(logLerp(1, 4000, v)) }; } }
    ],
    presets: [
      { name: 'Robot voice', p: { freq: 30, shape: 'sine', mix: 100 } },
      { name: 'Bells', p: { freq: 440, shape: 'sine', mix: 60 } },
      { name: 'Choppy', p: { freq: 12, shape: 'square', mix: 100 } }
    ],
    build: buildRing
  };

  PLUGINS.delay = {
    name: 'Stereo delay', cat: 'time', mix: 'balance', mixDef: 30,
    desc: 'Echoes, in time with the song or free. Filters in the feedback make each repeat darker, like tape or an old echo box.',
    params: [
      E('sync', 'Time', SYNC, '1/4', { group: 'Time' }),
      P('time', 'Time (free)', 1, 2000, 350, 'ms', { log: true, group: 'Time' }),
      P('offset', 'Right offset', -100, 100, 0, 'ms', { group: 'Time', hint: 'Delays the right side a little more or less, for width' }),
      P('feedback', 'Feedback', 0, 95, 35, '%', { group: 'Repeats', hint: 'How many repeats' }),
      E('pingpong', 'Ping-pong', ONOFF, 'off', { group: 'Repeats', hint: 'Repeats bounce left and right' }),
      P('hp', 'Low cut', 20, 2000, 120, 'Hz', { log: true, group: 'Tone' }),
      P('lp', 'High cut', 1000, 20000, 7000, 'Hz', { log: true, group: 'Tone' })
    ],
    structural: ['pingpong'],
    macros: [
      { k: 'repeats', label: 'Repeats', def: 0.37, fmt: pct, map: function (v) { return { feedback: Math.round(v * 90) }; } },
      { k: 'tone', label: 'Darkness', def: 0.4, fmt: pct, map: function (v) { return { lp: Math.round(logLerp(16000, 1800, v)) }; } }
    ],
    presets: [
      { name: 'Slapback', p: { sync: 'off', time: 110, feedback: 10, lp: 6000, mix: 30 } },
      { name: 'Quarter-note echo', p: { sync: '1/4', feedback: 35, mix: 25 } },
      { name: 'Dotted 8th (U2)', p: { sync: '1/8D', feedback: 45, lp: 8000, mix: 35 } },
      { name: 'Ping-pong', p: { sync: '1/8', feedback: 50, pingpong: 'on', mix: 30 } },
      { name: 'Dub', p: { sync: '1/4D', feedback: 75, hp: 300, lp: 2500, mix: 40 } },
      { name: 'Wide doubler', p: { sync: 'off', time: 18, offset: 12, feedback: 0, mix: 40 } }
    ],
    build: buildDelay
  };

  PLUGINS.tapedelay = {
    name: 'Tape echo', cat: 'time', mix: 'balance', mixDef: 30,
    desc: 'A tape-loop echo: warm, wobbly repeats that saturate and degrade as they feed back.',
    params: [
      E('sync', 'Time', SYNC, 'off'),
      P('time', 'Time (free)', 20, 2000, 300, 'ms', { log: true }),
      P('feedback', 'Feedback', 0, 110, 45, '%', { hint: 'Above 100% it runs away — the saturation keeps it from exploding' }),
      P('tone', 'Tone', 800, 12000, 3500, 'Hz', { log: true }),
      P('drive', 'Saturation', 0, 24, 6, 'dB'),
      P('wow', 'Wow & flutter', 0, 100, 25, '%')
    ],
    structural: [],
    macros: [
      { k: 'repeats', label: 'Repeats', def: 0.45, fmt: pct, map: function (v) { return { feedback: Math.round(v * 100) }; } },
      { k: 'age', label: 'Wear', def: 0.25, fmt: pct, map: function (v) { return { wow: Math.round(v * 100), tone: Math.round(logLerp(8000, 1500, v)) }; } }
    ],
    presets: [
      { name: 'Space echo', p: { time: 280, feedback: 55, tone: 3000, drive: 8, wow: 30 } },
      { name: 'Runaway', p: { time: 400, feedback: 104, tone: 2500, drive: 14, wow: 40, mix: 40 } },
      { name: 'Lo-fi slap', p: { time: 90, feedback: 15, tone: 2500, drive: 10, wow: 50 } }
    ],
    build: buildTapeDelay
  };

  PLUGINS.reverb = {
    name: 'Reverb', cat: 'time', mix: 'balance', mixDef: 25,
    desc: 'Puts the sound in a space, from a small room to a cathedral. Generated fresh from its settings.',
    params: [
      P('size', 'Decay', 0.2, 12, 1.8, 's', { log: true, step: 0.01, group: 'Space', hint: 'How long the tail rings' }),
      P('predelay', 'Pre-delay', 0, 250, 20, 'ms', { group: 'Space', hint: 'A gap before the reverb keeps the voice clear' }),
      P('er', 'Early reflections', 0, 100, 40, '%', { group: 'Space', hint: 'The first bounces off near walls' }),
      P('width', 'Width', 0, 100, 100, '%', { group: 'Space' }),
      P('damp', 'Damping', 1000, 20000, 6000, 'Hz', { log: true, group: 'Tone', hint: 'Real rooms lose treble as the sound dies away' }),
      P('lowcut', 'Low cut', 20, 1000, 150, 'Hz', { log: true, group: 'Tone', hint: 'Keeps bass from turning to mud' }),
      P('highcut', 'High cut', 1000, 20000, 12000, 'Hz', { log: true, group: 'Tone' })
    ],
    structural: ['size', 'er', 'width', 'damp'],
    macros: [
      { k: 'space', label: 'Space', def: 0.35, fmt: function (v) { return logLerp(0.3, 8, v).toFixed(1) + ' s'; }, map: function (v) { return { size: r2(logLerp(0.3, 8, v)), predelay: Math.round(lerp(5, 60, v)), er: Math.round(lerp(60, 25, v)) }; } },
      { k: 'bright', label: 'Brightness', def: 0.5, fmt: pct, map: function (v) { return { damp: Math.round(logLerp(1800, 18000, v)), highcut: Math.round(logLerp(4000, 20000, v)) }; } }
    ],
    presets: [
      { name: 'Small room', p: { size: 0.6, predelay: 5, er: 70, damp: 5000, mix: 20 } },
      { name: 'Vocal plate', p: { size: 1.8, predelay: 30, er: 20, damp: 9000, lowcut: 250, mix: 22 } },
      { name: 'Concert hall', p: { size: 2.8, predelay: 25, er: 40, damp: 5000, mix: 28 } },
      { name: 'Cathedral', p: { size: 7, predelay: 60, er: 30, damp: 3500, mix: 35 } },
      { name: 'Ambient wash', p: { size: 11, predelay: 90, er: 10, damp: 7000, lowcut: 300, mix: 50 } },
      { name: 'Drum room', p: { size: 0.9, predelay: 2, er: 85, damp: 7000, lowcut: 120, mix: 25 } }
    ],
    build: buildReverb
  };

  PLUGINS.pitch = {
    name: 'Pitch shifter', cat: 'util', mix: 'linear', mixDef: 100,
    desc: 'Raises or lowers the pitch without changing the speed. Mix it low for a harmony or a thicker double.',
    params: [
      P('semi', 'Semitones', -24, 24, 0, 'st', { step: 1 }),
      P('cents', 'Fine', -100, 100, 0, 'cents', { step: 1 }),
      P('grain', 'Grain', 20, 120, 50, 'ms', { hint: 'Shorter is tighter on drums, longer smoother on voice' })
    ],
    structural: [],
    macros: [
      { k: 'pitch', label: 'Pitch', def: 0.5, fmt: function (v) { var s = Math.round(lerp(-12, 12, v)); return (s > 0 ? '+' : '') + s + ' st'; }, map: function (v) { return { semi: Math.round(lerp(-12, 12, v)) }; } }
    ],
    presets: [
      { name: 'Octave down', p: { semi: -12, grain: 70 } },
      { name: 'Chipmunk', p: { semi: 7, grain: 40 } },
      { name: 'Fifth harmony', p: { semi: 7, mix: 40 } },
      { name: 'Thicken (detune)', p: { semi: 0, cents: 12, grain: 60, mix: 45 } }
    ],
    build: buildPitch
  };

  PLUGINS.utility = {
    name: 'Utility', cat: 'util',
    desc: 'Gain, stereo width, balance, polarity, channel swap and mono — the fixes every mix needs sometimes.',
    params: [
      P('gain', 'Gain', -48, 24, 0, 'dB', { step: 0.1 }),
      P('width', 'Stereo width', 0, 200, 100, '%', { hint: '0 is mono, above 100 exaggerates the sides' }),
      P('balance', 'Balance', -100, 100, 0, ''),
      E('invert', 'Polarity', [['none', 'Normal'], ['L', 'Flip left'], ['R', 'Flip right'], ['both', 'Flip both']], 'none'),
      E('swap', 'Swap left and right', ONOFF, 'off'),
      E('mono', 'Mono', ONOFF, 'off')
    ],
    structural: [],
    macros: [
      { k: 'width', label: 'Width', def: 0.5, fmt: function (v) { return Math.round(v * 200) + '%'; }, map: function (v) { return { width: Math.round(v * 200) }; } }
    ],
    presets: [
      { name: 'Mono check', p: { mono: 'on' } },
      { name: 'Extra wide', p: { width: 160 } },
      { name: 'Swap channels', p: { swap: 'on' } }
    ],
    build: buildUtility
  };

  PLUGINS.analyzer = {
    name: 'Analyzer', cat: 'util', meter: 'spectrum',
    desc: 'Shows the spectrum and the level without changing the sound. Put it last to see what you are sending out.',
    params: [],
    structural: [],
    macros: [],
    presets: [],
    build: function (ctx) { var g = ctx.createGain(); return { input: g, output: g, set: function () {} }; }
  };

  var ORDER = ['eq', 'filter', 'exciter', 'comp', 'limiter', 'gate', 'deess', 'multiband', 'transient', 'ducker',
    'drive', 'crush', 'tape', 'chorus', 'flanger', 'phaser', 'tremolo', 'autopan', 'ring',
    'delay', 'tapedelay', 'reverb', 'pitch', 'utility', 'analyzer'];

  // Every plugin gets an output level, and those with a Mix get the Mix.
  ORDER.forEach(function (k) {
    var d = PLUGINS[k];
    d.key = k;
    if (d.mix) d.params.push(P('mix', 'Mix', 0, 100, d.mixDef, '%', { group: 'Output', hint: 'Dry sound to fully effected' }));
    d.params.push(P('out', 'Output', -24, 24, 0, 'dB', { step: 0.1, group: 'Output' }));
    d.byKey = {};
    d.params.forEach(function (p) { d.byKey[p.k] = p; });
  });

  /* ----------------------------------------------------------- patches */

  // Whole chains. `for` says where it belongs: a track, the master, or both.
  var PATCHES = [
    { name: 'Podcast voice', for: 'track', desc: 'Clean, close and level, like radio.', chain: [
      { type: 'eq', preset: 'Podcast voice' }, { type: 'gate', preset: 'Voice (gentle)' },
      { type: 'comp', preset: 'Podcast' }, { type: 'deess', preset: 'Male voice' }] },
    { name: 'Radio DJ', for: 'track', desc: 'Big, bassy, in-your-face presenter voice.', chain: [
      { type: 'eq', p: { hpOn: 'on', hpFreq: 60, lsFreq: 140, lsGain: 4, p2Freq: 400, p2Gain: -3, p3Freq: 3500, p3Gain: 4, hsGain: 3 } },
      { type: 'comp', p: { thresh: -30, ratio: 6, knee: 4, attack: 3, release: 100 } },
      { type: 'exciter', preset: 'Vocal presence' }, { type: 'limiter', p: { gain: 4, ceiling: -1 } }] },
    { name: 'Singer, polished', for: 'track', desc: 'EQ, compression, de-essing and a touch of plate.', chain: [
      { type: 'eq', preset: 'Vocal clarity' }, { type: 'comp', preset: 'Vocal leveller' },
      { type: 'deess', preset: 'Female voice' }, { type: 'delay', p: { sync: '1/8D', feedback: 20, lp: 5000, mix: 12 } },
      { type: 'reverb', preset: 'Vocal plate' }] },
    { name: 'Telephone', for: 'track', desc: 'A voice down a phone line.', chain: [
      { type: 'eq', preset: 'Telephone' }, { type: 'drive', p: { type: 'soft', drive: 14, tone: 4000 } }, { type: 'crush', p: { bits: 12, down: 3, mix: 60 } }] },
    { name: 'Walkie-talkie', for: 'track', desc: 'Crunchy, band-limited radio chatter.', chain: [
      { type: 'eq', p: { hpOn: 'on', hpFreq: 600, hpSlope: '48', lpOn: 'on', lpFreq: 2600, lpSlope: '48', p2Freq: 1400, p2Gain: 8 } },
      { type: 'drive', p: { type: 'hard', drive: 26, tone: 3000 } }, { type: 'gate', p: { thresh: -40, range: 60 } }] },
    { name: 'Robot', for: 'track', desc: 'Metallic sci-fi voice.', chain: [
      { type: 'ring', preset: 'Robot voice' }, { type: 'flanger', preset: 'Metallic' }, { type: 'eq', p: { hpOn: 'on', hpFreq: 150 } }] },
    { name: 'Lo-fi', for: 'track', desc: 'Dusty, wobbly, band-limited.', chain: [
      { type: 'eq', p: { hpOn: 'on', hpFreq: 90, lpOn: 'on', lpFreq: 6000 } }, { type: 'tape', preset: 'Old cassette' },
      { type: 'crush', p: { bits: 12, down: 2, mix: 50 } }, { type: 'comp', preset: 'Gentle glue' }] },
    { name: 'Vintage tape', for: 'both', desc: 'Warm saturation and a gentle wobble.', chain: [
      { type: 'tape', preset: 'Studio 2-inch' }, { type: 'eq', preset: 'Warm it up' }] },
    { name: 'Underwater', for: 'track', desc: 'Muffled, swaying, far away.', chain: [
      { type: 'filter', p: { type: 'lowpass', freq: 450, res: 4, sync: 'off', rate: 0.3, depth: 15 } },
      { type: 'chorus', preset: 'Seasick' }, { type: 'reverb', p: { size: 3, damp: 1500, mix: 40 } }] },
    { name: 'Punchy drums', for: 'track', desc: 'Snap, weight and a short room.', chain: [
      { type: 'eq', preset: 'Kick punch' }, { type: 'transient', preset: 'Snappy drums' },
      { type: 'comp', preset: 'Punchy drums' }, { type: 'reverb', preset: 'Drum room' }] },
    { name: 'Fat bass', for: 'track', desc: 'Steady level, some grit and weight.', chain: [
      { type: 'eq', p: { hpOn: 'on', hpFreq: 30, lsFreq: 90, lsGain: 3, p2Freq: 700, p2Gain: 2 } },
      { type: 'drive', p: { type: 'tube', drive: 10, tone: 5000, mix: 50 } }, { type: 'comp', preset: 'Bass steady' }] },
    { name: 'Wide synth', for: 'track', desc: 'Chorus, delay and width.', chain: [
      { type: 'chorus', preset: '80s guitar' }, { type: 'delay', preset: 'Ping-pong' }, { type: 'utility', p: { width: 150 } }] },
    { name: 'Guitar amp', for: 'track', desc: 'Driven amp with a room.', chain: [
      { type: 'eq', p: { hpOn: 'on', hpFreq: 100, lpOn: 'on', lpFreq: 6500, p2Freq: 800, p2Gain: 3 } },
      { type: 'drive', preset: 'Crunchy' }, { type: 'reverb', preset: 'Small room' }] },
    { name: 'Dub delay', for: 'track', desc: 'Dark, long, feeding-back echoes.', chain: [
      { type: 'delay', preset: 'Dub' }, { type: 'reverb', p: { size: 2.5, mix: 20 } }] },
    { name: 'Dreamy', for: 'track', desc: 'Shimmering and huge.', chain: [
      { type: 'chorus', preset: 'Subtle doubler' }, { type: 'delay', p: { sync: '1/4D', feedback: 55, lp: 5000, mix: 30 } },
      { type: 'reverb', preset: 'Ambient wash' }] },
    { name: 'Music under voice', for: 'track', desc: 'Ducks this track whenever the chosen voice track speaks. Choose the voice in the Ducker.', chain: [
      { type: 'ducker', preset: 'Music under voice' }] },
    { name: 'Streaming master', for: 'master', desc: 'Gentle glue and a -1 dBTP ceiling, the level Spotify and YouTube ask for.', chain: [
      { type: 'eq', p: { hpOn: 'on', hpFreq: 25 } }, { type: 'multiband', preset: 'Master glue' }, { type: 'limiter', preset: 'Streaming loud' }] },
    { name: 'Loud master', for: 'master', desc: 'As loud as it goes without clipping.', chain: [
      { type: 'eq', p: { hpOn: 'on', hpFreq: 30, hsGain: 1.5 } }, { type: 'comp', p: { thresh: -16, ratio: 2.5, knee: 8, attack: 20, release: 200 } },
      { type: 'exciter', preset: 'Subtle sparkle' }, { type: 'limiter', p: { gain: 9, ceiling: -1, release: 50 } }] },
    { name: 'Podcast master', for: 'master', desc: 'Level voices and cap peaks for spoken word.', chain: [
      { type: 'comp', p: { thresh: -20, ratio: 2.5, knee: 8, attack: 10, release: 200, detect: 'rms' } }, { type: 'limiter', p: { gain: 4, ceiling: -1 } }] },
    { name: 'Warm master', for: 'master', desc: 'Tape colour and a soft top end.', chain: [
      { type: 'tape', p: { drive: 4, bump: 1.5, tone: 16000, wow: 0, flutter: 0 } }, { type: 'eq', preset: 'Warm it up' },
      { type: 'limiter', preset: 'Safety (-1 dBTP)' }] }
  ];

  /* ------------------------------------------------------ param maths */

  function r1(v) { return Math.round(v * 10) / 10; }
  function r2(v) { return Math.round(v * 100) / 100; }
  function pct(v) { return Math.round(v * 100) + '%'; }
  function spct(v) { var x = Math.round(lerp(-100, 100, v)); return (x > 0 ? '+' : '') + x + '%'; }
  function sdb(a, b) { return function (v) { var x = lerp(a, b, v); return (x > 0.05 ? '+' : '') + x.toFixed(1) + ' dB'; }; }
  function fmtHz(f) { return f >= 1000 ? (f / 1000).toFixed(f >= 10000 ? 1 : 2) + ' kHz' : Math.round(f) + ' Hz'; }

  function fmtValue(p, v) {
    if (p.opts) {
      for (var i = 0; i < p.opts.length; i++) if (String(p.opts[i][0]) === String(v)) return p.opts[i][1];
      return String(v);
    }
    if (p.unit === 'Hz') return fmtHz(v);
    if (p.unit === 'ms') return (v >= 100 ? Math.round(v) : v >= 10 ? v.toFixed(1) : v.toFixed(2)) + ' ms';
    if (p.unit === 's') return v.toFixed(2) + ' s';
    if (p.unit === ':1') return (v >= 10 ? v.toFixed(0) : v.toFixed(1)) + ':1';
    if (p.unit === 'dB' || p.unit === 'dBTP') return (v > 0 && p.min < 0 ? '+' : '') + v.toFixed(1) + ' ' + p.unit;
    var dec = p.step && p.step < 1 ? (p.step < 0.1 ? 2 : 1) : 0;
    return v.toFixed(dec) + (p.unit ? (p.unit === '%' ? '%' : ' ' + p.unit) : '');
  }

  // Slider position (0..1) <-> value, honouring the log scale.
  function toNorm(p, v) {
    if (p.log) { var lo = Math.max(p.min, 1e-3); return clamp(Math.log(v / lo) / Math.log(p.max / lo), 0, 1); }
    return clamp((v - p.min) / (p.max - p.min), 0, 1);
  }
  function fromNorm(p, n) {
    var v;
    if (p.log) { var lo = Math.max(p.min, 1e-3); v = lo * Math.pow(p.max / lo, n); } else v = p.min + (p.max - p.min) * n;
    return snapStep(p, v);
  }
  function snapStep(p, v) {
    v = clamp(v, p.min, p.max);
    var st = p.step || (p.max - p.min > 50 ? 1 : 0.01);
    if (p.log && !p.step) st = v >= 1000 ? 10 : v >= 100 ? 1 : v >= 10 ? 0.1 : 0.01;
    return Math.round(v / st) * st;
  }

  function defaults(type) {
    var d = PLUGINS[type], out = {};
    if (!d) return out;
    d.params.forEach(function (p) { out[p.k] = p.def; });
    return out;
  }

  // The complete parameter set for a slot: defaults under whatever it holds,
  // with numbers clamped and enums checked, so a hand-edited or old project
  // can never hand a builder something out of range.
  function resolve(slot) {
    var d = PLUGINS[slot.type], out = defaults(slot.type), src = slot.params || {};
    if (!d) return out;
    d.params.forEach(function (p) {
      if (!(p.k in src)) return;
      var v = src[p.k];
      if (p.opts) { if (p.kind === 'track' || p.opts.some(function (o) { return String(o[0]) === String(v); })) out[p.k] = String(v); }
      else if (typeof v === 'number' && isFinite(v)) out[p.k] = clamp(v, p.min, p.max);
    });
    return out;
  }

  function macroPatch(type, k, v) {
    var d = PLUGINS[type];
    var m = d && d.macros.filter(function (x) { return x.k === k; })[0];
    return m ? m.map(clamp(v, 0, 1)) : {};
  }

  // A fresh slot: defaults, then the macros at their resting positions, so a
  // knob always tells the truth about the parameters under it.
  function fresh(type) {
    var d = PLUGINS[type], params = defaults(type), m = {};
    d.macros.forEach(function (mc) { m[mc.k] = mc.def; Object.assign(params, mc.map(mc.def)); });
    return { type: type, params: params, m: d.macros.length ? m : null };
  }

  function presetSlot(type, preset) {
    var d = PLUGINS[type], pr = typeof preset === 'string' ? d.presets.filter(function (x) { return x.name === preset; })[0] : preset;
    var params = defaults(type);
    Object.assign(params, (pr && pr.p) || {});
    return { type: type, params: params, m: null };
  }

  function patchChain(patch) {
    return patch.chain.map(function (s) {
      var slot = s.preset ? presetSlot(s.type, s.preset) : fresh(s.type);
      if (s.p) { Object.assign(slot.params, s.p); slot.m = null; }
      return slot;
    });
  }

  function sig(slot) {
    var d = PLUGINS[slot.type];
    if (!d || slot.on === false) return '';
    var p = resolve(slot);
    return slot.type + '(' + d.structural.map(function (k) { return p[k]; }).join(',') + ')';
  }

  function latencyOf(slot, sr) {
    var d = PLUGINS[slot.type];
    if (!d || slot.on === false || !d.latency) return 0;
    return d.latency(sr) / sr;
  }

  // How long this plugin keeps sounding after its input stops, in seconds.
  function tailOf(slot, bpm) {
    if (slot.on === false) return 0;
    var p = resolve(slot);
    switch (slot.type) {
      case 'reverb': return p.size * 1.2 + p.predelay / 1000;
      case 'delay': case 'tapedelay': {
        var t = (p.sync !== 'off' && noteSec(p.sync, bpm)) || p.time / 1000;
        var fb = Math.min(0.95, p.feedback / 100);
        return fb < 0.01 ? t : Math.min(30, t * Math.log(0.001) / Math.log(fb));
      }
      case 'chorus': case 'flanger': case 'phaser': case 'pitch': return 0.15;
      case 'gate': case 'ducker': return p.release / 1000;
      default: return 0.02;
    }
  }

  /* ----------------------------------------- filter response (for drawing) */

  // Biquad coefficients exactly as the Web Audio spec defines them, so the
  // curve drawn is the curve the BiquadFilterNode applies.
  function biquadCoefs(type, f0, Q, gain, sr) {
    var w0 = 2 * Math.PI * clamp(f0, 1, sr / 2 - 1) / sr, cw = Math.cos(w0), sw = Math.sin(w0);
    var A = Math.pow(10, gain / 40), b0, b1, b2, a0, a1, a2, alpha;
    switch (type) {
      case 'lowpass':
        alpha = sw / (2 * Math.pow(10, Q / 20));
        b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
      case 'highpass':
        alpha = sw / (2 * Math.pow(10, Q / 20));
        b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
      case 'bandpass':
        alpha = sw / (2 * Q); b0 = alpha; b1 = 0; b2 = -alpha; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
      case 'notch':
        alpha = sw / (2 * Q); b0 = 1; b1 = -2 * cw; b2 = 1; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
      case 'allpass':
        alpha = sw / (2 * Q); b0 = 1 - alpha; b1 = -2 * cw; b2 = 1 + alpha; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
      case 'peaking':
        alpha = sw / (2 * Q);
        b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A; break;
      case 'lowshelf': {
        alpha = sw / 2 * Math.sqrt(2); var sa = 2 * Math.sqrt(A) * alpha;
        b0 = A * ((A + 1) - (A - 1) * cw + sa); b1 = 2 * A * ((A - 1) - (A + 1) * cw); b2 = A * ((A + 1) - (A - 1) * cw - sa);
        a0 = (A + 1) + (A - 1) * cw + sa; a1 = -2 * ((A - 1) + (A + 1) * cw); a2 = (A + 1) + (A - 1) * cw - sa; break;
      }
      case 'highshelf': {
        alpha = sw / 2 * Math.sqrt(2); var sb = 2 * Math.sqrt(A) * alpha;
        b0 = A * ((A + 1) + (A - 1) * cw + sb); b1 = -2 * A * ((A - 1) + (A + 1) * cw); b2 = A * ((A + 1) + (A - 1) * cw - sb);
        a0 = (A + 1) - (A - 1) * cw + sb; a1 = 2 * ((A - 1) - (A + 1) * cw); a2 = (A + 1) - (A - 1) * cw - sb; break;
      }
      default: return null;
    }
    return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
  }

  function magDb(c, f, sr) {
    var w = 2 * Math.PI * f / sr, c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
    var nr = c[0] + c[1] * c1 + c[2] * c2, ni = -(c[1] * s1 + c[2] * s2);
    var dr = 1 + c[3] * c1 + c[4] * c2, di = -(c[3] * s1 + c[4] * s2);
    return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di) + 1e-30);
  }

  // Butterworth sections for 12/24/48 dB per octave, as linear Q.
  var BUTTER = { 12: [0.7071], 24: [0.5412, 1.3066], 48: [0.5098, 0.6013, 0.9000, 2.5629] };

  // The EQ as a list of [type, freq, Q (in the node's own convention), gain].
  function eqBands(p) {
    var out = [];
    if (p.hpOn === 'on') BUTTER[p.hpSlope].forEach(function (q) { out.push(['highpass', p.hpFreq, qdb(q), 0]); });
    out.push(['lowshelf', p.lsFreq, 0, p.lsGain]);
    [1, 2, 3, 4].forEach(function (i) { out.push(['peaking', p['p' + i + 'Freq'], p['p' + i + 'Q'], p['p' + i + 'Gain']]); });
    out.push(['highshelf', p.hsFreq, 0, p.hsGain]);
    if (p.lpOn === 'on') BUTTER[p.lpSlope].forEach(function (q) { out.push(['lowpass', p.lpFreq, qdb(q), 0]); });
    return out;
  }

  // Magnitude response in dB at each frequency, for the EQ and filter curves.
  function response(type, params, freqs, sr) {
    sr = sr || 48000;
    var p = resolve({ type: type, params: params });
    var bands = type === 'eq' ? eqBands(p) : type === 'filter' ? [[p.type, p.freq, filterQ(p), 0]] : [];
    var cs = bands.map(function (b) { return biquadCoefs(b[0], b[1], b[2], b[3], sr); }).filter(Boolean);
    return freqs.map(function (f) { var s = 0; cs.forEach(function (c) { s += magDb(c, f, sr); }); return s; });
  }

  function filterQ(p) {
    // Resonance is in dB for every type. Low/high-pass take Q in dB already;
    // band-pass and notch take a ratio, so convert.
    if (p.type === 'lowpass' || p.type === 'highpass') return p.res - 3.01;
    return Math.max(0.1, Math.pow(10, p.res / 20) * 0.7071);
  }

  /* ========================================================= builders */
  // Below here runs only in a browser.

  function smooth(param, v, ctx, now) {
    if (now) { param.value = v; return; }
    param.setTargetAtTime(v, ctx.currentTime, 0.012);
  }

  function gain(ctx, v) { var g = ctx.createGain(); g.gain.value = v == null ? 1 : v; return g; }
  function stereo(node) { node.channelCount = 2; node.channelCountMode = 'explicit'; node.channelInterpretation = 'speakers'; return node; }
  function biquad(ctx, type, f, q, g) {
    var b = ctx.createBiquadFilter();
    b.type = type; b.frequency.value = f; b.Q.value = q || 0; b.gain.value = g || 0;
    return b;
  }
  function osc(ctx, type, f) {
    var o = ctx.createOscillator();
    o.type = type || 'sine'; o.frequency.value = f;
    o.start();
    return o;
  }
  function stopAll(list) { list.forEach(function (o) { try { o.stop(); } catch (e) {} }); }
  function lfoRate(p, bpm) {
    var s = p.sync && p.sync !== 'off' ? noteSec(p.sync, bpm) : null;
    return s ? 1 / s : p.rate;
  }

  /* ---- EQ */
  function buildEq(ctx, p) {
    var bands = eqBands(p), nodes = bands.map(function (b) { return biquad(ctx, b[0], b[1], b[2], b[3]); });
    var input = gain(ctx), node = input;
    nodes.forEach(function (n) { node.connect(n); node = n; });
    return {
      input: input, output: node,
      set: function (q, now) {
        eqBands(q).forEach(function (b, i) {
          var n = nodes[i];
          if (!n) return;
          smooth(n.frequency, b[1], ctx, now); smooth(n.Q, b[2], ctx, now); smooth(n.gain, b[3], ctx, now);
        });
      }
    };
  }

  /* ---- Filter */
  function buildFilter(ctx, p, env) {
    var input = gain(ctx), f = biquad(ctx, p.type, p.freq, filterQ(p), 0);
    var lfo = osc(ctx, p.shape, lfoRate(p, env.bpm)), amt = gain(ctx, 0);
    lfo.connect(amt); amt.connect(f.detune);
    input.connect(f);
    return {
      input: input, output: f,
      set: function (q, now) {
        f.type = q.type;
        smooth(f.frequency, q.freq, ctx, now); smooth(f.Q, filterQ(q), ctx, now);
        lfo.type = q.shape;
        smooth(lfo.frequency, lfoRate(q, env.bpm), ctx, now);
        smooth(amt.gain, q.depth / 100 * 2400, ctx, now);
      },
      dispose: function () { stopAll([lfo]); }
    };
  }

  /* ---- Exciter */
  function buildExciter(ctx, p) {
    var input = gain(ctx), out = gain(ctx);
    var h1 = biquad(ctx, 'highpass', p.freq, qdb(0.7071)), sh = ctx.createWaveShaper(), h2 = biquad(ctx, 'highpass', p.freq, qdb(0.7071)), amt = gain(ctx, 0);
    sh.oversample = '4x';
    input.connect(out);
    input.connect(h1); h1.connect(sh); sh.connect(h2); h2.connect(amt); amt.connect(out);
    var lastDrive = null;
    return {
      input: input, output: out,
      set: function (q, now) {
        smooth(h1.frequency, q.freq, ctx, now); smooth(h2.frequency, q.freq, ctx, now);
        if (q.drive !== lastDrive) { sh.curve = shaperCurve('soft', q.drive, 0); lastDrive = q.drive; }
        smooth(amt.gain, q.amount / 100 * 0.6, ctx, now);
      }
    };
  }

  /* ---- Drive */

  var curveCache = {};
  function shaperCurve(type, driveDb, bias) {
    var key = type + '|' + driveDb + '|' + bias;
    if (curveCache[key]) return curveCache[key];
    var n = 4096, c = new Float32Array(n), k = dbToGain(driveDb), b = bias / 100 * 0.35;
    var f = SHAPE_FN[type] || SHAPE_FN.soft;
    var off = f(b * k, k);
    for (var i = 0; i < n; i++) {
      var x = (i / (n - 1)) * 2 - 1;
      c[i] = f((x + b) * k, k) - off;
    }
    var keys = Object.keys(curveCache);
    if (keys.length > 64) delete curveCache[keys[0]];
    return (curveCache[key] = c);
  }
  var SHAPE_FN = {
    soft: function (x) { return Math.tanh(x); },
    tube: function (x) { return x >= 0 ? Math.tanh(x) : Math.tanh(x * 0.6) / 0.6 * 0.8; },
    tape: function (x) { return x / (1 + Math.abs(x)); },
    hard: function (x) { return clamp(x, -1, 1); },
    fuzz: function (x) { var s = x < 0 ? -1 : 1, a = Math.abs(x); return s * (1 - Math.exp(-a * (x < 0 ? 2.2 : 3.5))); },
    fold: function (x) { return Math.sin(x * Math.PI / 2); }
  };
  // Output trim that brings a -12 dBFS sine back to about -12 dBFS.
  function driveComp(type, driveDb, bias) {
    var c = shaperCurve(type, driveDb, bias), n = c.length, a = 0.25, sum = 0, ref = 0;
    for (var i = 0; i < 64; i++) {
      var x = a * Math.sin(2 * Math.PI * i / 64);
      var idx = Math.round((x + 1) / 2 * (n - 1));
      sum += c[idx] * c[idx]; ref += x * x;
    }
    return sum > 1e-12 ? Math.min(4, Math.sqrt(ref / sum)) : 1;
  }

  function buildDrive(ctx, p) {
    var input = gain(ctx), sh = ctx.createWaveShaper(), dc = biquad(ctx, 'highpass', 12, qdb(0.7071)), tone = biquad(ctx, 'lowpass', p.tone, qdb(0.7071)), trim = gain(ctx);
    sh.oversample = '4x';
    input.connect(sh); sh.connect(dc); dc.connect(tone); tone.connect(trim);
    var last = '';
    return {
      input: input, output: trim,
      set: function (q, now) {
        var key = q.type + q.drive + '|' + q.bias;
        if (key !== last) { sh.curve = shaperCurve(q.type, q.drive, q.bias); last = key; }
        smooth(tone.frequency, q.tone, ctx, now);
        smooth(trim.gain, q.auto === 'on' ? driveComp(q.type, q.drive, q.bias) : 1, ctx, now);
      }
    };
  }

  /* ---- Tape */
  function buildTape(ctx, p) {
    var input = gain(ctx), bump = biquad(ctx, 'peaking', 90, 0.8, p.bump), sh = ctx.createWaveShaper(), tone = biquad(ctx, 'lowpass', p.tone, qdb(0.6)), trim = gain(ctx);
    var dl = ctx.createDelay(0.1); dl.delayTime.value = 0.012;
    var wow = osc(ctx, 'sine', 0.55), wowAmt = gain(ctx, 0), flt = osc(ctx, 'sine', 7.3), fltAmt = gain(ctx, 0);
    wow.connect(wowAmt); wowAmt.connect(dl.delayTime); flt.connect(fltAmt); fltAmt.connect(dl.delayTime);
    sh.oversample = '2x';
    input.connect(bump); bump.connect(sh); sh.connect(tone); tone.connect(dl); dl.connect(trim);
    var last = null;
    return {
      input: input, output: trim,
      set: function (q, now) {
        if (q.drive !== last) { sh.curve = shaperCurve('tape', q.drive * 0.8 + 2, 5); last = q.drive; }
        smooth(bump.gain, q.bump, ctx, now);
        smooth(tone.frequency, q.tone, ctx, now);
        smooth(wowAmt.gain, q.wow / 100 * 0.004, ctx, now);
        smooth(fltAmt.gain, q.flutter / 100 * 0.0006, ctx, now);
        smooth(trim.gain, driveComp('tape', q.drive * 0.8 + 2, 5), ctx, now);
      },
      dispose: function () { stopAll([wow, flt]); }
    };
  }

  /* ---- Chorus */
  function buildChorus(ctx, p) {
    var input = stereo(gain(ctx)), split = ctx.createChannelSplitter(2), merge = ctx.createChannelMerger(2);
    var dL = ctx.createDelay(0.1), dR = ctx.createDelay(0.1);
    var lfo = osc(ctx, 'sine', p.rate), aL = gain(ctx, 0), aR = gain(ctx, 0);
    lfo.connect(aL); lfo.connect(aR); aL.connect(dL.delayTime); aR.connect(dR.delayTime);
    input.connect(split); split.connect(dL, 0); split.connect(dR, 1);
    dL.connect(merge, 0, 0); dR.connect(merge, 0, 1);
    return {
      input: input, output: merge,
      set: function (q, now) {
        smooth(lfo.frequency, q.rate, ctx, now);
        var d = q.delay / 1000, a = q.depth / 2000;
        smooth(dL.delayTime, d, ctx, now); smooth(dR.delayTime, d, ctx, now);
        smooth(aL.gain, a, ctx, now); smooth(aR.gain, a * (1 - 2 * q.width / 100), ctx, now);
      },
      dispose: function () { stopAll([lfo]); }
    };
  }

  /* ---- Flanger and phaser: in the worklet, because a Web Audio feedback
     loop cannot be shorter than 128 samples, and both need it shorter. */
  function buildFlanger(ctx, p) {
    var mk = function (q) { return { delay: q.delay, depth: q.depth, rate: q.rate, feedback: q.feedback / 100, width: q.width / 100 }; };
    var n = wnode(ctx, 'as-flange', mk(p));
    if (!n) return passthrough(ctx);
    return { input: n, output: n, set: function (q, now) { var d = mk(q); Object.keys(d).forEach(function (k) { wset(n, k, d[k], ctx, now); }); } };
  }

  function buildPhaser(ctx, p, env) {
    var mk = function (q) { return { stages: +q.stages, rate: lfoRate(q, env.bpm), depth: q.depth / 100, center: q.center, feedback: q.feedback / 100 }; };
    var n = wnode(ctx, 'as-phase', mk(p));
    if (!n) return passthrough(ctx);
    return { input: n, output: n, set: function (q, now) { var d = mk(q); Object.keys(d).forEach(function (k) { wset(n, k, d[k], ctx, k === 'stages' || now); }); } };
  }

  /* ---- Tremolo */
  function buildTremolo(ctx, p, env) {
    var input = stereo(gain(ctx)), split = ctx.createChannelSplitter(2), merge = ctx.createChannelMerger(2);
    var gL = gain(ctx), gR = gain(ctx), lfo = osc(ctx, p.shape, lfoRate(p, env.bpm)), aL = gain(ctx, 0), aR = gain(ctx, 0);
    input.connect(split); split.connect(gL, 0); split.connect(gR, 1);
    gL.connect(merge, 0, 0); gR.connect(merge, 0, 1);
    lfo.connect(aL); lfo.connect(aR); aL.connect(gL.gain); aR.connect(gR.gain);
    return {
      input: input, output: merge,
      set: function (q, now) {
        lfo.type = q.shape;
        smooth(lfo.frequency, lfoRate(q, env.bpm), ctx, now);
        var d = q.depth / 100 / 2;
        smooth(gL.gain, 1 - d, ctx, now); smooth(gR.gain, 1 - d, ctx, now);
        smooth(aL.gain, d, ctx, now); smooth(aR.gain, d * (1 - 2 * q.stereo / 100), ctx, now);
      },
      dispose: function () { stopAll([lfo]); }
    };
  }

  /* ---- Auto-pan */
  function buildAutopan(ctx, p, env) {
    var input = stereo(gain(ctx)), pan = ctx.createStereoPanner(), lfo = osc(ctx, p.shape, lfoRate(p, env.bpm)), a = gain(ctx, 0);
    lfo.connect(a); a.connect(pan.pan); input.connect(pan);
    return {
      input: input, output: pan,
      set: function (q, now) {
        lfo.type = q.shape;
        smooth(lfo.frequency, lfoRate(q, env.bpm), ctx, now);
        smooth(a.gain, q.depth / 100, ctx, now);
      },
      dispose: function () { stopAll([lfo]); }
    };
  }

  /* ---- Ring mod */
  function buildRing(ctx, p) {
    var input = gain(ctx), vca = gain(ctx, 0), o = osc(ctx, p.shape, p.freq);
    input.connect(vca); o.connect(vca.gain);
    return {
      input: input, output: vca,
      set: function (q, now) { o.type = q.shape; smooth(o.frequency, q.freq, ctx, now); },
      dispose: function () { stopAll([o]); }
    };
  }

  /* ---- Stereo delay */
  function buildDelay(ctx, p, env) {
    var input = stereo(gain(ctx)), split = ctx.createChannelSplitter(2), merge = ctx.createChannelMerger(2);
    input.connect(split);
    var sides = [0, 1].map(function () {
      var inG = gain(ctx), d = ctx.createDelay(5), hp = biquad(ctx, 'highpass', p.hp, qdb(0.7071)), lp = biquad(ctx, 'lowpass', p.lp, qdb(0.7071)), fb = gain(ctx, 0);
      inG.connect(d); d.connect(hp); hp.connect(lp); lp.connect(fb);
      return { inG: inG, d: d, hp: hp, lp: lp, fb: fb };
    });
    var ping = p.pingpong === 'on';
    if (ping) {
      // Mono in on the left; each repeat crosses to the other side.
      split.connect(sides[0].inG, 0); split.connect(sides[0].inG, 1);
      sides[0].inG.gain.value = 0.5;
      sides[0].fb.connect(sides[1].d); sides[1].fb.connect(sides[0].d);
    } else {
      split.connect(sides[0].inG, 0); split.connect(sides[1].inG, 1);
      sides[0].fb.connect(sides[0].d); sides[1].fb.connect(sides[1].d);
    }
    sides[0].lp.connect(merge, 0, 0); sides[1].lp.connect(merge, 0, 1);
    return {
      input: input, output: merge,
      set: function (q, now) {
        var t = (q.sync !== 'off' && noteSec(q.sync, env.bpm)) || q.time / 1000;
        smooth(sides[0].d.delayTime, clamp(t, 0.001, 4.9), ctx, now);
        smooth(sides[1].d.delayTime, clamp(ping ? t : t + q.offset / 1000, 0.001, 4.9), ctx, now);
        sides.forEach(function (s) {
          smooth(s.fb.gain, q.feedback / 100, ctx, now);
          smooth(s.hp.frequency, q.hp, ctx, now); smooth(s.lp.frequency, q.lp, ctx, now);
        });
      }
    };
  }

  /* ---- Tape echo */
  function buildTapeDelay(ctx, p, env) {
    var input = gain(ctx), sum = gain(ctx), d = ctx.createDelay(5), sh = ctx.createWaveShaper(), tone = biquad(ctx, 'lowpass', p.tone, qdb(0.7071)),
      hp = biquad(ctx, 'highpass', 90, qdb(0.7071)), fb = gain(ctx, 0), out = gain(ctx);
    var wow = osc(ctx, 'sine', 0.7), wa = gain(ctx, 0), flt = osc(ctx, 'triangle', 6.1), fa = gain(ctx, 0);
    wow.connect(wa); wa.connect(d.delayTime); flt.connect(fa); fa.connect(d.delayTime);
    input.connect(sum); sum.connect(d); d.connect(sh); sh.connect(tone); tone.connect(hp); hp.connect(fb); fb.connect(sum); hp.connect(out);
    var last = null;
    return {
      input: input, output: out,
      set: function (q, now) {
        var t = (q.sync !== 'off' && noteSec(q.sync, env.bpm)) || q.time / 1000;
        smooth(d.delayTime, clamp(t, 0.02, 4.9), ctx, now);
        if (q.drive !== last) { sh.curve = shaperCurve('soft', q.drive, 8); last = q.drive; }
        smooth(tone.frequency, q.tone, ctx, now);
        smooth(fb.gain, q.feedback / 100, ctx, now);
        smooth(wa.gain, q.wow / 100 * 0.003, ctx, now); smooth(fa.gain, q.wow / 100 * 0.0004, ctx, now);
        smooth(out.gain, driveComp('soft', q.drive, 8), ctx, now);
      },
      dispose: function () { stopAll([wow, flt]); }
    };
  }

  /* ---- Reverb */

  // Seeded, so the same settings always give the same room.
  function rng(seed) {
    var s = seed >>> 0 || 1;
    return function () { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296 * 2 - 1; };
  }

  var irCache = {};
  function reverbIR(sr, size, damp, er, width) {
    var key = [sr, size, damp, er, width].join('|');
    if (irCache[key]) return irCache[key];
    var len = Math.max(64, Math.ceil(size * 1.2 * sr)), k = 6.91 / size;
    var r = rng(12345), chans = [new Float32Array(len), new Float32Array(len)];
    var n2 = new Float32Array(len);
    // Width 0 is the same tail in both ears; 100 is two unrelated tails.
    var rho = 1 - width / 100, a = Math.sqrt((1 + Math.sqrt(1 - rho * rho)) / 2), b = Math.sqrt((1 - Math.sqrt(1 - rho * rho)) / 2);
    var onset = Math.floor(0.012 * sr);
    for (var i = 0; i < len; i++) {
      var t = i / sr, env = Math.exp(-k * t) * (i < onset ? i / onset : 1);
      var x = r(), y = r();
      chans[0][i] = (a * x + b * y) * env;
      n2[i] = (b * x + a * y) * env;
    }
    chans[1] = n2;
    // Treble dies faster than bass: a one-pole low-pass whose cutoff slides
    // from 18 kHz down to `damp` over the length of the decay.
    for (var c = 0; c < 2; c++) {
      var d = chans[c], zc = 0, coef = 0;
      for (var j = 0; j < len; j++) {
        if ((j & 63) === 0) {
          var fc = logLerp(18000, damp, Math.min(1, j / (size * sr)));
          coef = Math.exp(-2 * Math.PI * Math.min(fc, sr * 0.45) / sr);
        }
        zc = d[j] * (1 - coef) + zc * coef;
        d[j] = zc;
      }
    }
    // Early reflections: a handful of discrete bounces in the first 80 ms.
    if (er > 0) {
      var re = rng(777);
      for (var e = 0; e < 14; e++) {
        var te = 0.006 + Math.pow((e + 1) / 14, 1.4) * 0.075;
        for (var cc = 0; cc < 2; cc++) {
          var at = Math.floor((te + (cc ? 0.0011 * (e % 3) : 0)) * sr);
          if (at < len) chans[cc][at] += re() * 0.9 * (er / 100) * Math.exp(-te * 18) * 6;
        }
      }
    }
    // Fixed energy, so turning the decay up does not also turn the level up.
    for (var q = 0; q < 2; q++) {
      var s = 0, dd = chans[q];
      for (var m = 0; m < len; m++) s += dd[m] * dd[m];
      var g = s > 0 ? Math.sqrt(0.2 / s) : 0;
      for (var m2 = 0; m2 < len; m2++) dd[m2] *= g;
    }
    var keys = Object.keys(irCache);
    if (keys.length > 8) delete irCache[keys[0]];
    return (irCache[key] = chans);
  }

  function buildReverb(ctx, p) {
    var input = stereo(gain(ctx)), pre = ctx.createDelay(1), lc = biquad(ctx, 'highpass', p.lowcut, qdb(0.7071)), hc = biquad(ctx, 'lowpass', p.highcut, qdb(0.7071));
    var conv = ctx.createConvolver();
    conv.normalize = false;
    var ir = reverbIR(ctx.sampleRate, p.size, p.damp, p.er, p.width);
    var buf = ctx.createBuffer(2, ir[0].length, ctx.sampleRate);
    buf.copyToChannel(ir[0], 0); buf.copyToChannel(ir[1], 1);
    conv.buffer = buf;
    input.connect(pre); pre.connect(lc); lc.connect(conv); conv.connect(hc);
    return {
      input: input, output: hc,
      set: function (q, now) {
        smooth(pre.delayTime, q.predelay / 1000, ctx, now);
        smooth(lc.frequency, q.lowcut, ctx, now); smooth(hc.frequency, q.highcut, ctx, now);
      }
    };
  }

  /* ---- Utility */
  function buildUtility(ctx) {
    var input = stereo(gain(ctx)), split = ctx.createChannelSplitter(2), merge = ctx.createChannelMerger(2), g = gain(ctx);
    var ll = gain(ctx), lr = gain(ctx), rl = gain(ctx), rr = gain(ctx);   // from-to
    input.connect(split);
    split.connect(ll, 0); split.connect(lr, 0); split.connect(rl, 1); split.connect(rr, 1);
    ll.connect(merge, 0, 0); rl.connect(merge, 0, 0); lr.connect(merge, 0, 1); rr.connect(merge, 0, 1);
    merge.connect(g);
    return {
      input: input, output: g,
      set: function (q, now) {
        var w = q.mono === 'on' ? 0 : q.width / 100;
        var same = 0.5 + 0.5 * w, cross = 0.5 - 0.5 * w;
        var sl = (q.invert === 'L' || q.invert === 'both') ? -1 : 1, sr = (q.invert === 'R' || q.invert === 'both') ? -1 : 1;
        var bl = Math.min(1, 1 - q.balance / 100), br = Math.min(1, 1 + q.balance / 100);
        // out L = same·L + cross·R, then swap, then polarity and balance.
        var m = q.swap === 'on' ? [[cross, same], [same, cross]] : [[same, cross], [cross, same]];
        smooth(ll.gain, m[0][0] * sl * bl, ctx, now); smooth(rl.gain, m[0][1] * sl * bl, ctx, now);
        smooth(lr.gain, m[1][0] * sr * br, ctx, now); smooth(rr.gain, m[1][1] * sr * br, ctx, now);
        smooth(g.gain, dbToGain(q.gain), ctx, now);
      }
    };
  }

  /* ------------------------------------------------ worklet plugins */

  // The processors are written as a function and shipped as a Blob URL, so
  // the page needs no extra file and the service worker no extra entry.
  function workletSource() {
    /* global sampleRate, registerProcessor, AudioWorkletProcessor */
    var K = function (name, def, min, max) { return { name: name, defaultValue: def, minValue: min, maxValue: max, automationRate: 'k-rate' }; };
    var dbg = function (db) { return Math.pow(10, db / 20); };

    // Compressor, gate and ducker in one: detect a level (optionally from a
    // second "key" input, through an optional high-pass), compute a gain
    // change in dB, smooth it with separate attack and release, apply it.
    class DynProc extends AudioWorkletProcessor {
      static get parameterDescriptors() {
        return [K('mode', 0, 0, 2), K('thresh', -18, -100, 0), K('ratio', 3, 1, 100), K('knee', 6, 0, 48), K('attack', 10, 0.01, 1000),
          K('release', 150, 1, 5000), K('makeup', 0, -40, 40), K('range', 40, 0, 100), K('hold', 0, 0, 2000), K('scHp', 0, 0, 2000), K('rms', 0, 0, 1)];
      }
      constructor() {
        super();
        this.g = 0; this.env = 0; this.holdLeft = 0; this.minGr = 0; this.blocks = 0;
        this.hp = [0, 0, 0, 0, 0]; this.hpF = -1; this.z = [[0, 0], [0, 0]];
      }
      setHp(f) {
        this.hpF = f;
        if (f <= 0) return;
        var w = 2 * Math.PI * Math.min(f, sampleRate * 0.45) / sampleRate, cw = Math.cos(w), al = Math.sin(w) / (2 * 0.7071), a0 = 1 + al;
        this.hp = [(1 + cw) / 2 / a0, -(1 + cw) / a0, (1 + cw) / 2 / a0, -2 * cw / a0, (1 - al) / a0];
      }
      process(inputs, outputs, P) {
        var main = inputs[0], key = inputs[1] && inputs[1].length ? inputs[1] : main, out = outputs[0];
        var n = out[0].length;
        if (!main.length) { for (var c0 = 0; c0 < out.length; c0++) out[c0].fill(0); return true; }
        var mode = P.mode[0], T = P.thresh[0], R = P.ratio[0], W = P.knee[0], rms = P.rms[0] > 0.5;
        var att = Math.exp(-1 / (Math.max(0.01, P.attack[0]) * 0.001 * sampleRate));
        var rel = Math.exp(-1 / (Math.max(1, P.release[0]) * 0.001 * sampleRate));
        var detc = Math.exp(-1 / (0.01 * sampleRate));
        // Peak detectors hold the peak and fall back at the release rate (the
        // compressor) or over 15 ms (gate and ducker). Feeding the raw sample
        // level to the gain computer instead lets the gain relax at every
        // zero crossing, and a tone 10 dB over at 4:1 got 6.8 dB, not 7.5.
        var pkRel = mode === 0 ? rel : Math.exp(-1 / (0.015 * sampleRate));
        var up = mode === 0 ? Math.exp(-1 / (0.002 * sampleRate)) : rel;
        var mk = P.makeup[0], range = P.range[0], hold = P.hold[0] * 0.001 * sampleRate;
        if (P.scHp[0] !== this.hpF) this.setHp(P.scHp[0]);
        var useHp = this.hpF > 0, h = this.hp;
        var minGr = 0;
        for (var i = 0; i < n; i++) {
          var lev = 0;
          for (var c = 0; c < key.length && c < 2; c++) {
            var x = key[c][i];
            if (useHp) {
              var z = this.z[c], y = h[0] * x + z[0];
              z[0] = h[1] * x - h[3] * y + z[1];
              z[1] = h[2] * x - h[4] * y;
              x = y;
            }
            var a = x < 0 ? -x : x;
            if (a > lev) lev = a;
          }
          var L;
          if (rms) { this.env = detc * this.env + (1 - detc) * lev * lev; L = 10 * Math.log10(this.env + 1e-20); }
          else { this.env = lev > this.env ? lev : this.env * pkRel; L = 20 * Math.log10(this.env + 1e-10); }
          var target;
          if (mode === 0) {
            var over = L - T;
            if (2 * over < -W) target = 0;
            else if (W > 0 && 2 * Math.abs(over) <= W) target = (1 / R - 1) * (over + W / 2) * (over + W / 2) / (2 * W);
            else target = (1 / R - 1) * over;
            if (target < -range) target = -range;
          } else if (mode === 1) {
            if (L >= T) { target = 0; this.holdLeft = hold; }
            else if (this.holdLeft > 0) { this.holdLeft--; target = 0; }
            else target = -range;
          } else {
            if (L >= T) { target = -range; this.holdLeft = hold; }
            else if (this.holdLeft > 0) { this.holdLeft--; target = -range; }
            else target = 0;
          }
          // Gates open on the attack and close on the release; compressors
          // and duckers clamp down on the attack and let go on the release.
          var down = target < this.g;
          var coef = mode === 1 ? (down ? rel : att) : (down ? att : (rms ? rel : up));
          this.g = target + (this.g - target) * coef;
          if (this.g < minGr) minGr = this.g;
          var gl = dbg(this.g + mk);
          for (var o = 0; o < out.length; o++) {
            var src = main[o] || main[0];
            out[o][i] = src[i] * gl;
          }
        }
        if (minGr < this.minGr) this.minGr = minGr;
        if (++this.blocks >= 8) { this.port.postMessage(this.minGr); this.minGr = 0; this.blocks = 0; }
        return true;
      }
    }
    registerProcessor('as-dyn', DynProc);

    // Look-ahead limiter that holds the true peak (4x interpolated, the way
    // BS.1770 measures it) under the ceiling. The gain is the minimum of the
    // required gains over the look-ahead window, eased back up by the
    // release, then box-averaged over the same window: every value averaged
    // already covers the sample it lands on, so the average can never exceed
    // what that sample needs, and the gain arrives smoothly instead of as a
    // step.
    class LimProc extends AudioWorkletProcessor {
      static get parameterDescriptors() { return [K('ceiling', -1, -30, 0), K('gain', 0, -24, 36), K('release', 80, 1, 2000)]; }
      constructor() {
        super();
        var T = 24, L = Math.max(16, Math.round(0.004 * sampleRate));
        this.T = T; this.L = L;
        this.hist = [new Float32Array(2 * T + 1), new Float32Array(2 * T + 1)]; this.hi = 0;
        this.dl = [new Float32Array(L - 1), new Float32Array(L - 1)]; this.di = 0;
        this.kern = [];
        for (var p = 1; p < 4; p++) {
          var t = p / 4, k = new Float32Array(2 * T);
          for (var j = -T + 1, idx = 0; j <= T; j++, idx++) {
            var x = t - j, s = Math.abs(x) < 1e-9 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
            var d = (j - t) / T;
            k[idx] = s * (Math.abs(d) <= 1 ? 0.5 * (1 + Math.cos(Math.PI * d)) : 0);
          }
          this.kern.push(k);
        }
        this.dqV = new Float32Array(L + 1); this.dqI = new Float64Array(L + 1); this.dqH = 0; this.dqT = 0;
        this.box = new Float64Array(L); this.bi = 0; this.bsum = L; for (var b = 0; b < L; b++) this.box[b] = 1;
        this.rel = 1; this.n = 0; this.minG = 1; this.blocks = 0;
      }
      process(inputs, outputs, P) {
        var inp = inputs[0], out = outputs[0], n = out[0].length;
        var ceil = dbg(P.ceiling[0]), pre = dbg(P.gain[0]);
        var rc = 1 - Math.exp(-1 / (Math.max(1, P.release[0]) * 0.001 * sampleRate));
        var T = this.T, L = this.L, H = 2 * T + 1, minG = 1;
        for (var i = 0; i < n; i++) {
          // 1. Take the input into the interpolation history.
          for (var c = 0; c < 2; c++) {
            var src = inp.length ? (inp[c] || inp[0]) : null;
            this.hist[c][this.hi] = src ? src[i] * pre : 0;
          }
          this.hi = (this.hi + 1) % H;
          // 2. True peak around the sample T behind the newest.
          var pk = 0;
          for (var c2 = 0; c2 < 2; c2++) {
            var hs = this.hist[c2], base = this.hi;   // oldest sample
            var mid = hs[(base + T) % H], nx = hs[(base + T + 1) % H], am = mid < 0 ? -mid : mid, an = nx < 0 ? -nx : nx;
            if (am > pk) pk = am;
            if (am > ceil * 0.5 || an > ceil * 0.5) {
              for (var q = 0; q < 3; q++) {
                var kk = this.kern[q], sum = 0;
                for (var m = 0; m < 2 * T; m++) sum += hs[(base + 1 + m) % H] * kk[m];
                var as = sum < 0 ? -sum : sum;
                if (as > pk) pk = as;
              }
            }
          }
          var req = pk > ceil ? ceil / pk : 1;
          // 3. Sliding minimum over L (a monotonic deque).
          var idx = this.n++;
          while (this.dqT > this.dqH && this.dqV[(this.dqT - 1) % (L + 1)] >= req) this.dqT--;
          this.dqV[this.dqT % (L + 1)] = req; this.dqI[this.dqT % (L + 1)] = idx; this.dqT++;
          while (this.dqI[this.dqH % (L + 1)] <= idx - L) this.dqH++;
          var hold = this.dqV[this.dqH % (L + 1)];
          // 4. Release, never above what the window requires.
          this.rel = Math.min(hold, this.rel + (1 - this.rel) * rc);
          // 5. Box average over L.
          this.bsum += this.rel - this.box[this.bi];
          this.box[this.bi] = this.rel;
          this.bi = (this.bi + 1) % L;
          var g = this.bsum / L;
          if (g < minG) minG = g;
          // 6. The sample this gain belongs to: the true-peak centre, delayed
          //    by L - 1 more.
          for (var c3 = 0; c3 < 2; c3++) {
            var hs3 = this.hist[c3], ctr = hs3[(this.hi + T) % H];
            var dl = this.dl[c3];
            var outV = dl[this.di] * g;
            dl[this.di] = ctr;
            if (out[c3]) out[c3][i] = outV;
          }
          this.di = (this.di + 1) % (L - 1);
        }
        if (minG < this.minG) this.minG = minG;
        if (++this.blocks >= 8) { this.port.postMessage(20 * Math.log10(this.minG)); this.minG = 1; this.blocks = 0; }
        return true;
      }
    }
    registerProcessor('as-lim', LimProc);

    class CrushProc extends AudioWorkletProcessor {
      static get parameterDescriptors() { return [K('bits', 8, 1, 24), K('down', 4, 1, 256)]; }
      constructor() { super(); this.hold = [0, 0]; this.ph = 0; }
      process(inputs, outputs, P) {
        var inp = inputs[0], out = outputs[0], n = out[0].length;
        var q = Math.pow(2, Math.round(P.bits[0]) - 1), dn = Math.max(1, Math.round(P.down[0]));
        for (var i = 0; i < n; i++) {
          if (this.ph <= 0) {
            for (var c = 0; c < 2; c++) {
              var s = inp.length ? (inp[c] || inp[0])[i] : 0;
              this.hold[c] = Math.round(s * q) / q;
            }
            this.ph = dn;
          }
          this.ph--;
          for (var o = 0; o < out.length; o++) out[o][i] = this.hold[o] || 0;
        }
        return true;
      }
    }
    registerProcessor('as-crush', CrushProc);

    // Two read heads sweep through a delay line at the pitch ratio, half a
    // grain apart, crossfaded with complementary sine-squared windows. When a
    // head's window reaches zero it jumps back a grain. Where it lands is
    // chosen by cross-correlation with the other head, within one 15 ms
    // search span: a blind jump lands out of phase as often as in, and the
    // two heads then cancel — an octave up on a 220 Hz tone measured 460 Hz,
    // the sidebands of that beating, instead of 440.
    class PitchProc extends AudioWorkletProcessor {
      static get parameterDescriptors() { return [K('ratio', 1, 0.25, 4), K('grain', 50, 10, 200)]; }
      constructor() {
        super();
        this.N = Math.ceil(0.5 * sampleRate);
        this.buf = [new Float32Array(this.N), new Float32Array(this.N)]; this.mono = new Float32Array(this.N);
        this.w = 0; this.ph = 0; this.off = [0, 0]; this.S = Math.round(0.015 * sampleRate); this.K = Math.round(0.006 * sampleRate);
      }
      read(b, pos) {
        var N = this.N; pos = ((pos % N) + N) % N;
        var i = Math.floor(pos), f = pos - i;
        return b[i] * (1 - f) + b[(i + 1) % N] * f;
      }
      align(head, G, r) {
        var other = 1 - head, pho = (this.ph + (other ? 0.5 : 0)) % 1;
        var dO = pho * G + this.off[other], base = r > 1 ? G : 0, best = 0, bestC = -Infinity, N = this.N, m = this.mono;
        for (var o = 0; o <= this.S; o += 2) {
          var c = 0, dn = base + o;
          for (var j = 0; j < this.K; j += 2) {
            var ia = ((this.w - Math.round(dn) - j) % N + N) % N, ib = ((this.w - Math.round(dO) - j) % N + N) % N;
            c += m[ia] * m[ib];
          }
          if (c > bestC) { bestC = c; best = o; }
        }
        this.off[head] = best;
      }
      process(inputs, outputs, P) {
        var inp = inputs[0], out = outputs[0], n = out[0].length;
        var r = P.ratio[0], G = Math.max(64, P.grain[0] * 0.001 * sampleRate);
        for (var i = 0; i < n; i++) {
          var l = inp.length ? inp[0][i] : 0, rr = inp.length ? (inp[1] || inp[0])[i] : 0;
          this.buf[0][this.w] = l; this.buf[1][this.w] = rr; this.mono[this.w] = l + rr;
          var prev = this.ph;
          this.ph += (1 - r) / G;
          this.ph -= Math.floor(this.ph);
          // A head wraps when its phase crosses 0/1: head 0 at ph, head 1 at ph + 0.5.
          var p1 = (prev + 0.5) % 1, q1 = (this.ph + 0.5) % 1;
          if (r > 1 ? this.ph > prev : this.ph < prev) this.align(0, G, r);
          if (r > 1 ? q1 > p1 : q1 < p1) this.align(1, G, r);
          var ph2 = q1;
          var d1 = this.ph * G + this.off[0], d2 = ph2 * G + this.off[1];
          var w1 = Math.sin(Math.PI * this.ph), w2 = Math.sin(Math.PI * ph2);
          w1 *= w1; w2 *= w2;
          for (var o = 0; o < out.length; o++) {
            var b = this.buf[o] || this.buf[0];
            out[o][i] = this.read(b, this.w - d1 - 1) * w1 + this.read(b, this.w - d2 - 1) * w2;
          }
          this.w = (this.w + 1) % this.N;
        }
        return true;
      }
    }
    registerProcessor('as-pitch', PitchProc);

    // Transients are where a fast envelope runs ahead of a slow one;
    // sustain is where a slow-release envelope hangs above a fast-release one.
    class TransProc extends AudioWorkletProcessor {
      static get parameterDescriptors() { return [K('attack', 0, -100, 100), K('sustain', 0, -100, 100)]; }
      constructor() { super(); this.e = [0, 0, 0, 0]; this.g = 0; }
      process(inputs, outputs, P) {
        var inp = inputs[0], out = outputs[0], n = out[0].length;
        var ca = function (ms) { return Math.exp(-1 / (ms * 0.001 * sampleRate)); };
        var fA = ca(0.5), fR = ca(40), sA = ca(20), sR = ca(40), lA = ca(1), lR = ca(350), kA = ca(1), kR = ca(25), gs = ca(3);
        var A = P.attack[0] / 100, S = P.sustain[0] / 100, e = this.e;
        for (var i = 0; i < n; i++) {
          var lev = 0;
          for (var c = 0; c < inp.length && c < 2; c++) { var a = Math.abs(inp[c][i]); if (a > lev) lev = a; }
          e[0] = lev > e[0] ? fA * e[0] + (1 - fA) * lev : fR * e[0] + (1 - fR) * lev;
          e[1] = lev > e[1] ? sA * e[1] + (1 - sA) * lev : sR * e[1] + (1 - sR) * lev;
          e[2] = lev > e[2] ? lA * e[2] + (1 - lA) * lev : lR * e[2] + (1 - lR) * lev;
          e[3] = lev > e[3] ? kA * e[3] + (1 - kA) * lev : kR * e[3] + (1 - kR) * lev;
          var tr = 20 * Math.log10((e[0] + 1e-6) / (e[1] + 1e-6));
          var su = 20 * Math.log10((e[2] + 1e-6) / (e[3] + 1e-6));
          var target = Math.max(-24, Math.min(9, A * Math.max(0, tr) * 1.5 + S * Math.max(0, su) * 1.2));
          this.g = target + (this.g - target) * gs;
          var gl = Math.pow(10, this.g / 20);
          for (var o = 0; o < out.length; o++) out[o][i] = inp.length ? (inp[o] || inp[0])[i] * gl : 0;
        }
        return true;
      }
    }
    registerProcessor('as-trans', TransProc);

    class FlangeProc extends AudioWorkletProcessor {
      static get parameterDescriptors() { return [K('delay', 2, 0.1, 20), K('depth', 1.5, 0, 10), K('rate', 0.25, 0.01, 20), K('feedback', 0.6, -0.97, 0.97), K('width', 0.5, 0, 1)]; }
      constructor() { super(); this.N = Math.ceil(0.05 * sampleRate); this.buf = [new Float32Array(this.N), new Float32Array(this.N)]; this.w = 0; this.ph = 0; }
      process(inputs, outputs, P) {
        var inp = inputs[0], out = outputs[0], n = out[0].length, N = this.N;
        var base = P.delay[0] * 0.001 * sampleRate, dep = P.depth[0] * 0.001 * sampleRate, fb = P.feedback[0], off = P.width[0] * 0.5, inc = P.rate[0] / sampleRate;
        for (var i = 0; i < n; i++) {
          this.ph = (this.ph + inc) % 1;
          for (var c = 0; c < 2; c++) {
            var ph = (this.ph + (c ? off : 0)) % 1, tri = 1 - 4 * Math.abs(ph - 0.5);
            var d = Math.max(1, base + dep * 0.5 * (1 + tri));
            var pos = this.w - d, b = this.buf[c];
            pos = ((pos % N) + N) % N;
            var k = Math.floor(pos), f = pos - k;
            var y = b[k] * (1 - f) + b[(k + 1) % N] * f;
            var x = inp.length ? (inp[c] || inp[0])[i] : 0;
            b[this.w] = x + fb * y;
            if (out[c]) out[c][i] = y;
          }
          this.w = (this.w + 1) % N;
        }
        return true;
      }
    }
    registerProcessor('as-flange', FlangeProc);

    // First-order all-pass stages swept by a sine LFO, with feedback from the
    // last stage to the first. Changing the stage count is just a loop bound.
    class PhaseProc extends AudioWorkletProcessor {
      static get parameterDescriptors() { return [K('stages', 6, 2, 12), K('rate', 0.4, 0.01, 20), K('depth', 0.7, 0, 1), K('center', 700, 50, 8000), K('feedback', 0.4, 0, 0.95)]; }
      constructor() { super(); this.x1 = [new Float64Array(12), new Float64Array(12)]; this.y1 = [new Float64Array(12), new Float64Array(12)]; this.last = [0, 0]; this.ph = 0; this.a = [0, 0]; }
      process(inputs, outputs, P) {
        var inp = inputs[0], out = outputs[0], n = out[0].length;
        var st = Math.max(2, Math.min(12, Math.round(P.stages[0]))), inc = P.rate[0] / sampleRate, dep = P.depth[0] * 2, fc = P.center[0], fb = P.feedback[0];
        for (var i = 0; i < n; i++) {
          this.ph = (this.ph + inc) % 1;
          if ((i & 7) === 0) {
            for (var cc = 0; cc < 2; cc++) {
              var f = fc * Math.pow(2, dep * Math.sin(2 * Math.PI * (this.ph + cc * 0.08)));
              var t = Math.tan(Math.PI * Math.min(f, sampleRate * 0.45) / sampleRate);
              this.a[cc] = (t - 1) / (t + 1);
            }
          }
          for (var c = 0; c < 2; c++) {
            var x = (inp.length ? (inp[c] || inp[0])[i] : 0) + fb * this.last[c], a = this.a[c], X = this.x1[c], Y = this.y1[c];
            for (var s = 0; s < st; s++) {
              var y = a * x + X[s] - a * Y[s];
              X[s] = x; Y[s] = y; x = y;
            }
            this.last[c] = x;
            if (out[c]) out[c][i] = x;
          }
        }
        return true;
      }
    }
    registerProcessor('as-phase', PhaseProc);
  }

  var workletReady = typeof WeakMap === 'function' ? new WeakMap() : null;
  var workletUrl = null;
  function loadWorklet(ctx) {
    if (!ctx.audioWorklet || !workletReady) return Promise.resolve(false);
    if (workletReady.has(ctx)) return workletReady.get(ctx);
    if (!workletUrl) {
      workletUrl = URL.createObjectURL(new Blob(['(' + workletSource.toString() + ')();'], { type: 'application/javascript' }));
    }
    var pr = ctx.audioWorklet.addModule(workletUrl).then(function () { return true; }, function (e) {
      console.warn('[audio-editor] effect worklet failed to load', e);
      return false;
    });
    workletReady.set(ctx, pr);
    return pr;
  }
  function hasWorklet(ctx) {
    return !!(workletReady && workletReady.has(ctx) && ctx.__asWorklet);
  }
  // Remember the resolved value synchronously, so builders can check it.
  function ensureWorklet(ctx) {
    return loadWorklet(ctx).then(function (ok) { ctx.__asWorklet = ok; return ok; });
  }

  function wnode(ctx, name, params, inputs) {
    if (!hasWorklet(ctx)) return null;
    return new AudioWorkletNode(ctx, name, {
      numberOfInputs: inputs || 1, numberOfOutputs: 1, outputChannelCount: [2],
      channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers',
      parameterData: params
    });
  }
  function wset(node, k, v, ctx, now) { var ap = node.parameters.get(k); if (ap) smooth(ap, v, ctx, now); }
  function passthrough(ctx) { var g = gain(ctx); return { input: g, output: g, set: function () {}, missing: true }; }
  function grTap(node, inst) {
    inst.gr = 0;
    node.port.onmessage = function (e) { inst.gr = e.data; };
    inst.meter = function () { return inst.gr; };
    return inst;
  }

  function compMakeup(q) { return q.auto === 'on' ? Math.max(0, -(q.thresh * (1 - 1 / q.ratio)) * 0.5) : 0; }

  function buildComp(ctx, p) {
    var n = wnode(ctx, 'as-dyn', dynParams(p));
    if (!n) return passthrough(ctx);
    return grTap(n, {
      input: n, output: n,
      set: function (q, now) { var d = dynParams(q); Object.keys(d).forEach(function (k) { wset(n, k, d[k], ctx, now); }); },
      dispose: function () { n.port.onmessage = null; }
    });
  }
  function dynParams(q) {
    return { mode: 0, thresh: q.thresh, ratio: q.ratio, knee: q.knee, attack: q.attack, release: q.release,
      makeup: q.makeup + compMakeup(q), scHp: q.scHp, rms: q.detect === 'rms' ? 1 : 0, range: 100 };
  }

  function LIM_LATENCY(sr) { return 24 + Math.max(16, Math.round(0.004 * sr)) - 1; }
  function buildLimiter(ctx, p) {
    var n = wnode(ctx, 'as-lim', { ceiling: p.ceiling, gain: p.gain, release: p.release });
    if (!n) return passthrough(ctx);
    return grTap(n, {
      input: n, output: n,
      set: function (q, now) { wset(n, 'ceiling', q.ceiling, ctx, now); wset(n, 'gain', q.gain, ctx, now); wset(n, 'release', q.release, ctx, now); },
      dispose: function () { n.port.onmessage = null; }
    });
  }

  function buildGate(ctx, p) {
    var mk = function (q) { return { mode: 1, thresh: q.thresh, range: q.range, attack: q.attack, hold: q.hold, release: q.release, scHp: q.scHp }; };
    var n = wnode(ctx, 'as-dyn', mk(p));
    if (!n) return passthrough(ctx);
    return grTap(n, {
      input: n, output: n,
      set: function (q, now) { var d = mk(q); Object.keys(d).forEach(function (k) { wset(n, k, d[k], ctx, now); }); },
      dispose: function () { n.port.onmessage = null; }
    });
  }

  function buildDucker(ctx, p, env) {
    var mk = function (q) { return { mode: 2, thresh: q.thresh, range: q.range, attack: q.attack, hold: q.hold, release: q.release }; };
    var n = wnode(ctx, 'as-dyn', mk(p), 2);
    if (!n) return passthrough(ctx);
    var key = env.key && p.src ? env.key(p.src) : null;
    if (key) key.connect(n, 0, 1);
    var inst = {
      input: n, output: n,
      set: function (q, now) { var d = mk(q); Object.keys(d).forEach(function (k) { wset(n, k, d[k], ctx, now); }); },
      dispose: function () { if (key) try { key.disconnect(n); } catch (e) {} n.port.onmessage = null; }
    };
    if (!key) inst.note = p.src ? 'The track it listens to is gone.' : 'Choose a track to listen to.';
    return grTap(n, inst);
  }

  // Linkwitz-Riley 4th order: two Butterworth 2nd-order sections.
  function lr4(ctx, type, f) {
    var a = biquad(ctx, type, f, qdb(0.7071)), b = biquad(ctx, type, f, qdb(0.7071));
    a.connect(b);
    return { input: a, output: b, set: function (fr, now) { smooth(a.frequency, fr, ctx, now); smooth(b.frequency, fr, ctx, now); } };
  }

  function buildDeess(ctx, p) {
    var input = gain(ctx), out = gain(ctx);
    var lo = lr4(ctx, 'lowpass', p.freq), hi = lr4(ctx, 'highpass', p.freq);
    // Reduction is capped at "Max reduction": a compressor with no floor on
    // its gain change would hollow the voice out on a loud "s".
    var mk = function (q) { return { mode: 0, thresh: q.thresh, ratio: 8, knee: 3, attack: 0.5, release: 60, makeup: 0, range: q.range }; };
    var n = wnode(ctx, 'as-dyn', mk(p));
    input.connect(lo.input); lo.output.connect(out);
    input.connect(hi.input);
    if (n) { hi.output.connect(n); n.connect(out); } else hi.output.connect(out);
    var inst = {
      input: input, output: out,
      set: function (q, now) {
        lo.set(q.freq, now); hi.set(q.freq, now);
        if (n) { wset(n, 'thresh', q.thresh, ctx, now); wset(n, 'range', q.range, ctx, now); }
      }
    };
    return n ? grTap(n, inst) : inst;
  }

  function buildMultiband(ctx, p) {
    var input = gain(ctx), out = gain(ctx);
    var lo = lr4(ctx, 'lowpass', p.x1), rest = lr4(ctx, 'highpass', p.x1);
    var mid = lr4(ctx, 'lowpass', p.x2), high = lr4(ctx, 'highpass', p.x2);
    // The low band never passes the upper crossover, so it gets that
    // crossover's phase shift from an all-pass instead; without it the three
    // bands do not sum back flat.
    var ap = biquad(ctx, 'allpass', p.x2, 0.7071, 0);
    input.connect(lo.input); lo.output.connect(ap);
    input.connect(rest.input); rest.output.connect(mid.input); rest.output.connect(high.input);
    var bands = [['l', ap], ['m', mid.output], ['h', high.output]].map(function (b) {
      var q = function (pp) { return { mode: 0, thresh: pp[b[0] + 'Thresh'], ratio: pp[b[0] + 'Ratio'], knee: 6, attack: pp.attack, release: pp.release, makeup: pp[b[0] + 'Gain'] }; };
      var n = wnode(ctx, 'as-dyn', q(p)), g = gain(ctx);
      if (n) { b[1].connect(n); n.connect(g); } else b[1].connect(g);
      g.connect(out);
      var band = { n: n, q: q, gr: 0 };
      if (n) n.port.onmessage = function (e) { band.gr = e.data; };
      return band;
    });
    return {
      input: input, output: out,
      set: function (q, now) {
        lo.set(q.x1, now); rest.set(q.x1, now); mid.set(q.x2, now); high.set(q.x2, now); smooth(ap.frequency, q.x2, ctx, now);
        bands.forEach(function (b) { if (!b.n) return; var d = b.q(q); Object.keys(d).forEach(function (k) { wset(b.n, k, d[k], ctx, now); }); });
      },
      meter: function () { return Math.min.apply(null, bands.map(function (b) { return b.gr; })); },
      bands: function () { return bands.map(function (b) { return b.gr; }); },
      dispose: function () { bands.forEach(function (b) { if (b.n) b.n.port.onmessage = null; }); }
    };
  }

  function buildTransient(ctx, p) {
    var n = wnode(ctx, 'as-trans', { attack: p.attack, sustain: p.sustain });
    if (!n) return passthrough(ctx);
    return { input: n, output: n, set: function (q, now) { wset(n, 'attack', q.attack, ctx, now); wset(n, 'sustain', q.sustain, ctx, now); } };
  }

  function buildCrush(ctx, p) {
    var n = wnode(ctx, 'as-crush', { bits: p.bits, down: p.down });
    if (!n) return passthrough(ctx);
    return { input: n, output: n, set: function (q, now) { wset(n, 'bits', q.bits, ctx, true); wset(n, 'down', q.down, ctx, true); } };
  }

  function buildPitch(ctx, p) {
    var ratio = function (q) { return Math.pow(2, (q.semi + q.cents / 100) / 12); };
    var n = wnode(ctx, 'as-pitch', { ratio: ratio(p), grain: p.grain });
    if (!n) return passthrough(ctx);
    return { input: n, output: n, set: function (q, now) { wset(n, 'ratio', ratio(q), ctx, now); wset(n, 'grain', q.grain, ctx, now); } };
  }

  /* ------------------------------------------------- the slot wrapper */

  // Wraps a plugin with its output level and, where it has one, its Mix.
  // The instance keeps `in` and `out` so the engine can meter either side.
  function create(ctx, slot, env) {
    var d = PLUGINS[slot.type];
    if (!d) return null;
    var p = resolve(slot);
    var inN = stereo(gain(ctx)), outN = gain(ctx, dbToGain(p.out));
    var core = d.build(ctx, p, env || {});
    var dry = null, wet = null;
    if (d.mix) {
      dry = gain(ctx); wet = gain(ctx);
      inN.connect(dry); dry.connect(outN);
      inN.connect(core.input); core.output.connect(wet); wet.connect(outN);
    } else {
      inN.connect(core.input); core.output.connect(outN);
    }
    var inst = {
      id: slot.id, type: slot.type, sig: sig(slot), in: inN, out: outN, core: core, params: p,
      latency: d.latency ? d.latency(ctx.sampleRate) / ctx.sampleRate : 0,
      set: function (q, now) {
        q = resolve({ type: slot.type, params: q });
        inst.params = q;
        core.set(q, now);
        if (d.mix) {
          var m = q.mix / 100, dg, wg;
          if (d.mix === 'balance') { dg = Math.min(1, 2 * (1 - m)); wg = Math.min(1, 2 * m); }
          else { dg = 1 - m; wg = m; }
          smooth(dry.gain, dg, ctx, now); smooth(wet.gain, wg, ctx, now);
        }
        smooth(outN.gain, dbToGain(q.out), ctx, now);
      },
      meter: function () { return core.meter ? core.meter() : null; },
      dispose: function () {
        try { if (core.dispose) core.dispose(); } catch (e) {}
        [inN, outN, dry, wet].forEach(function (x) { if (x) try { x.disconnect(); } catch (e) {} });
      },
      note: core.note || (core.missing ? 'This browser cannot run this effect, so it is passing the sound through unchanged.' : null)
    };
    inst.set(p, true);
    return inst;
  }

  var api = {
    PLUGINS: PLUGINS, ORDER: ORDER, CATS: CATS, PATCHES: PATCHES,
    defaults: defaults, resolve: resolve, fresh: fresh, presetSlot: presetSlot, patchChain: patchChain,
    macroPatch: macroPatch, sig: sig, tailOf: tailOf, latencyOf: latencyOf, noteSec: noteSec,
    fmtValue: fmtValue, fmtHz: fmtHz, toNorm: toNorm, fromNorm: fromNorm, snapStep: snapStep,
    response: response, biquadCoefs: biquadCoefs, reverbIR: reverbIR, shaperCurve: shaperCurve,
    create: create, ensureWorklet: ensureWorklet
  };
  global.ASEditDsp = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
