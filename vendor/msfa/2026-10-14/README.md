# msfa (DX7-style FM engine), built for AudioSaw

`dx7.wasm` is the sound engine behind `/dx7-synth`. It is driven by
`js/dx7-core.js` (`ASDx7`) and checked by `node tools/check-dx7.js`.

- **Source:** https://github.com/asb2m10/dexed, directory `Source/msfa`
- **Pinned commit:** `fea2f0f0f2c397799f59b27eb11c038cd34b22c5` (14 Oct 2026),
  which is this folder's name
- **Upstream of that:** https://github.com/google/music-synthesizer-for-android
- **Built with:** Emscripten 6.0.10 (`em++`)
- **Size:** 24,951 bytes. **Imports:** none.

## What is compiled, and under which licence

All from `Source/msfa`, unmodified, each carrying an Apache-2.0 header
(`build.sh` refuses to build if one does not):

| File | Licence | Copyright |
|---|---|---|
| `dx7note.cc`, `dx7note.h` | Apache-2.0 | Google Inc. 2012; Pascal Gauthier 2016-2025 |
| `env.cc`, `env.h` | Apache-2.0 | Google Inc. 2012; Pascal Gauthier 2017 |
| `exp2.cc`, `exp2.h` | Apache-2.0 | Google Inc. 2012-2013 |
| `fm_core.cc`, `fm_core.h` | Apache-2.0 | Google Inc. 2012 |
| `fm_op_kernel.cc`, `fm_op_kernel.h` | Apache-2.0 | Google Inc. 2012 |
| `freqlut.cc`, `freqlut.h` | Apache-2.0 | Google Inc. 2012 |
| `lfo.cc`, `lfo.h` | Apache-2.0 | Google Inc. 2013 |
| `pitchenv.cc`, `pitchenv.h` | Apache-2.0 | Google Inc. 2012-2013 |
| `porta.cpp`, `porta.h` | Apache-2.0 | Jean Pierre Cimalando 2019 |
| `sin.cc`, `sin.h` | Apache-2.0 | Google Inc. 2012 |
| `aligned_buf.h`, `controllers.h`, `module.h`, `synth.h` | Apache-2.0 | Google Inc. 2012-2013 |

Written for this build (AGPL-3.0-or-later, like the site), in `wrapper/`:

| File | What it is |
|---|---|
| `dx7_wasm.cc` | The exported C interface: 16-voice allocator, note/pedal/bend/wheel handling, sysex unpacking, block-size-free rendering |
| `shim/msfa/tuning.h` | Stand-in for Dexed's `tuning.h`: equal temperament, A4 = 440 Hz |
| `shim/msfa/libMTSClient.h` | Stand-in for ODDSound's MTS-ESP client: "no master" |
| `shim/debugger/Logger.h` | Empty; `controllers.h` includes Dexed's JUCE logger and uses nothing from it |
| `shim/iostream` | Empty; `dx7note.cc` includes `<iostream>` for a commented-out line, and the real header would pull WASI file imports into the module |

**Deliberately not compiled:**

- `Source/msfa/tuning.cc` and `tuning.h`: no licence header, and they need
  JUCE and the Surge tuning library (.scl/.kbm microtuning).
- Everything in Dexed outside `Source/msfa`, all of it GPL-3.0:
  `PluginProcessor` (its voice allocator), `PluginData` (its sysex code),
  `EngineMkI` and `EngineOpl` (the "Mark I" and "OPL" engine modes),
  `PluginFx` (the filter), `DXLookNFeel` and the rest of the interface.
- No Yamaha ROM cartridge, and none of the cartridges Dexed bundles. The
  voices on the page are written for AudioSaw and live in `js/dx7-core.js`.

So the module is Apache-2.0 code plus our own; nothing GPL from Dexed is in it.

## Build

```sh
sh build.sh                      # -> $TMPDIR/dx7-build/out/dx7.wasm
DX7_BUILD_DIR=/some/dir sh build.sh
```

It clones Dexed, checks out the pinned commit, copies the files above into a
clean directory with the shims, and runs:

```
em++ -O2 -std=c++17 -fno-exceptions -fno-rtti -I work/sys -I work/msfa <sources>
  --no-entry -sSTANDALONE_WASM=1
  -sALLOW_MEMORY_GROWTH=0 -sINITIAL_MEMORY=2097152 -sSTACK_SIZE=65536
  -sMALLOC=emmalloc -sFILESYSTEM=0 -sEXPORTED_FUNCTIONS=_malloc,_free
```

- **Standalone, no imports,** so `new WebAssembly.Module(bytes)` and
  `new WebAssembly.Instance(module, {})` are all it takes, inside an
  AudioWorklet too. It is a WASI reactor: call `_initialize()` once first.
- **Memory is fixed at 2 MB** and never grows, so typed-array views on
  `memory.buffer` stay valid for the instance's life.
- **One synth per instance.** msfa keeps its sample-rate tables in statics.

## Exports

```
_initialize()
dx7_init(double sampleRate)
dx7_load_voice(const uint8_t *voice, int len)        len 155 or 156; returns 1
dx7_unpack_syx(const uint8_t *syx, int len, uint8_t *out)
     4104-byte bank or 163-byte single voice -> 155-byte voices (name at
     145..154); returns 32 or 1, 0 if it is not one, -1 for a bad checksum
dx7_note_on(int midi, int velocity1to127)
dx7_note_off(int midi)
dx7_sustain(int on)
dx7_pitch_bend(int value0to16383)                    8192 is centre
dx7_bend_range(int semitones)                        default 2
dx7_mod_wheel(int value0to127)
dx7_all_notes_off()
dx7_gain(float)                                      default 0.5
dx7_active_voices()
dx7_render(float *out, int nframes)                  mono, any nframes
malloc, free, memory
```

## What differs from the instrument

- This is msfa's own ("modern", 24-bit) core. Dexed's "Mark I" mode, which
  imitates the DX7's 12-bit sine table and DAC, is GPL and is not here. The
  result is cleaner than the hardware.
- The engine runs at the host's sample rate, not the DX7's 49,096 Hz, so
  where aliasing lands differs with the rate.
- Pitch-bend range and what the mod wheel does are function-memory settings
  on a DX7, not part of a voice. Here: bend 2 semitones (settable), wheel =
  pitch modulation from the voice's LFO, scaled by its pitch sensitivity.
- No portamento, no mono mode, no aftertouch, breath or foot controller.
- Changing the voice does not change notes that are already sounding.
