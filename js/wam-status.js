/*
 * Written by tools/check-wam.js: what each community WAM2 plugin measured in
 * headless Chrome. ASWam.catalog() hides the ones marked hide, and the plugin
 * browsers show the rest with these notes. Do not edit by hand; re-run the
 * check (WAM_DOWNLOAD=1 refreshes the mirror first).
 *
 *   ok      loads and renders repeatably in an OfflineAudioContext (export)
 *   state   'restores': a saved setting renders exactly as it was set;
 *           'differs': it reloads, but not sample-exactly;
 *           'none': the plugin keeps no state; 'no-params': nothing to move
 *   delay   samples an impulse comes out late (the plugin's own report of
 *           its latency is not used: it said 128 for plugins with none)
 *   live    'same': live playback matches the export within 2e-3 of peak;
 *           'differs': it does not (usually a free-running LFO)
 */
window.ASWamStatus = {
 "checked": "2026-10-10",
 "plugins": {
  "com.wimmics.bigmuff": {
   "ok": true,
   "state": "restores",
   "live": "same"
  },
  "com.wimmics.blipper": {
   "ok": true,
   "state": "restores",
   "live": "differs"
  },
  "com.wimmics.csoundpitchshifter": {
   "ok": true,
   "state": "restores",
   "live": "same",
   "delay": 2846
  },
  "com.wimmics.deathgate": {
   "ok": true,
   "state": "restores",
   "live": "same"
  },
  "com.wimmics.distomachine": {
   "ok": false,
   "hide": true,
   "why": "not repeatable offline"
  },
  "com.sequencerParty.drumComputer": {
   "ok": false,
   "hide": true,
   "why": "silent"
  },
  "com.wimmics.dualpitchshifter": {
   "ok": true,
   "state": "restores",
   "live": "same"
  },
  "com.wimmics.graphicequalizer": {
   "ok": true,
   "state": "restores",
   "live": "same"
  },
  "com.wimmics.greyhole": {
   "ok": true,
   "state": "restores",
   "live": "differs"
  },
  "com.wimmics.kbverb": {
   "ok": true,
   "state": "restores",
   "live": "same"
  },
  "com.wimmics.kppdistorder": {
   "ok": true,
   "state": "restores",
   "live": "same"
  },
  "com.wimmics.kppfuzz": {
   "ok": true,
   "state": "restores",
   "live": "same"
  },
  "com.wimmics.livegain": {
   "ok": true,
   "state": "restores",
   "live": "same"
  },
  "com.sequencerParty.microverb": {
   "ok": true,
   "state": "restores",
   "live": "differs"
  },
  "com.wimmics.oscilloscope": {
   "ok": true,
   "state": "restores",
   "live": "same"
  },
  "com.wimmics.osctube": {
   "ok": true,
   "state": "restores",
   "live": "same"
  },
  "com.wimmics.overdriverix": {
   "ok": true,
   "state": "restores",
   "live": "same"
  },
  "com.wimmics.owldirty": {
   "ok": true,
   "state": "restores",
   "live": "same"
  },
  "com.wimmics.owlshimmer": {
   "ok": true,
   "state": "restores",
   "live": "differs"
  },
  "com.wimmics.pedalboardwac2022": {
   "ok": false,
   "hide": true,
   "why": "Failed to fetch dynamically imported module: https://www.webaudiomodules.com/community/plugins/wimmics/PedalBoard-WAC2022/src/index.js"
  },
  "com.wimmics.pingpongdelay": {
   "ok": true,
   "state": "restores",
   "live": "same"
  },
  "com.wimmics.quadrafuzz": {
   "ok": true,
   "state": "restores",
   "live": "same"
  },
  "com.wimmics.reactpedalboard": {
   "ok": true,
   "state": "no-params",
   "live": "same"
  },
  "com.sequencerParty.simpleDelay": {
   "ok": true,
   "state": "restores",
   "live": "same"
  },
  "com.sequencerParty.simpleDistortion": {
   "ok": true,
   "state": "restores",
   "live": "same"
  },
  "com.sequencerParty.simpleEQ": {
   "ok": true,
   "state": "restores",
   "live": "same"
  },
  "com.wimmics.smoothdelay": {
   "ok": true,
   "state": "restores",
   "live": "same"
  },
  "com.sequencerParty.soundfont": {
   "ok": false,
   "hide": true,
   "why": "silent"
  },
  "com.wimmics.spectrogram": {
   "ok": true,
   "state": "restores",
   "live": "same"
  },
  "com.wimmics.spectroscope": {
   "ok": true,
   "state": "restores",
   "live": "same"
  },
  "com.sequencerParty.modal": {
   "ok": true,
   "state": "restores",
   "live": "differs"
  },
  "com.wimmics.stereofreqshifter": {
   "ok": true,
   "state": "restores",
   "live": "same"
  },
  "com.wimmics.sweetwah": {
   "ok": true,
   "state": "restores",
   "live": "same"
  },
  "com.sequencerParty.synth101": {
   "ok": false,
   "hide": true,
   "why": "not repeatable offline"
  },
  "com.wimmics.temper": {
   "ok": true,
   "state": "restores"
  },
  "com.wimmics.ts9overdrive": {
   "ok": true,
   "state": "restores",
   "live": "same"
  },
  "com.wimmics.guitarampsim60s": {
   "ok": true,
   "state": "restores",
   "live": "same"
  }
 }
};
