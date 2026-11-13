# modplay 1.0.0

One standalone WebAssembly file that renders tracker modules to PCM, used by
`js/module-play.js` (`ASModule`) and checked by `node tools/check-module.js`.

## What is inside

Three replayers by Olav Sørensen (8bitbubsy), each a C port of the original
tracker's own player code, all BSD-3-Clause:

| Project | Pinned commit | Plays | Licence file |
|---|---|---|---|
| [pt2-clone](https://github.com/8bitbubsy/pt2-clone) | `80aff083768b04c3ad765c71e01d88593d424855` | MOD with up to 4 channels (ProTracker 2.3D replayer, Paula emulation with BLEP and the Amiga filters) | `LICENSE-pt2-clone.txt` |
| [ft2play](https://github.com/8bitbubsy/ft2play) | `39af5ccd8cb7d6cdb8a74c0307c73841750b2c37` | XM, and MOD with 6 to 32 channels (Fasttracker 2.09 replayer and mixer) | `LICENSE-ft2play.txt` |
| [it2play](https://github.com/8bitbubsy/it2play) | `c8fefba91ba2709cd959a6c66bbbb554399bd12b` | IT, and S3M as Impulse Tracker imports it (IT 2.15 replayer, the project's own "HQ" float mixer) | `LICENSE-it2play.txt` |

A page that ships this file has to reproduce those copyright notices; linking
to the three licence files here does it.

From pt2-clone only the replayer, the Paula mixer, the 2x downsampler, the
tables and the two MOD loaders are compiled. Its SDL audio layer and its UI
are replaced by `glue/glue_pt2.c`, parts of which follow pt2-clone's own code
and say so. `glue/sdlstub/SDL2/SDL.h` is a few typedefs so its headers compile
without SDL. No SDL code is in the build.

## Changes to upstream

Two, both in `patches/`, three lines each: a counter that is bumped where
ft2play (`getNextPos`) and it2play (`UpdateData`) move to another order.
That is how the glue knows a song has come back round. pt2-clone is unpatched:
it has its own row-visit table for MOD2WAV, and that is what ends a MOD.

Everything else is in `glue/`:

- `modplay.c`: the exports, format detection, and the checks a file must pass
  before a loader is trusted with it.
- `glue_pt2.c`, `glue_ft2.c`, `glue_it2.c`: one engine each, driven a tick at
  a time, handing out the mix as float before the tracker's 16-bit stage.
- `mp_driver.h`: force-included; the four "audio driver" functions the
  replayers expect, and `malloc` mapped to `calloc` so that a sample the file
  cuts short ends in silence instead of old heap contents.

## Build

`./build.sh` (git, emscripten 6.0.10, network). It clones the three
repositories at the commits above, applies the patches and links:

```
emcc -O2 -DNDEBUG -fno-strict-aliasing -include glue/mp_driver.h    (per file)
emcc -O2 --no-entry -sSTANDALONE_WASM=1 -sALLOW_MEMORY_GROWTH=1
     -sINITIAL_MEMORY=16MB -sMAXIMUM_MEMORY=2GB -sSTACK_SIZE=1MB
     -sMALLOC=emmalloc -sFILESYSTEM=0
```

No threads, no SharedArrayBuffer, no filesystem, no JS glue. The only import
is `env.emscripten_notify_memory_growth` (a no-op is enough).

## Exports

`memory`, `_initialize` (call once), and:

| Export | |
|---|---|
| `mp_alloc(n)`, `mp_free(p)` | wasm heap |
| `mp_load(ptr, len, rate)` | 0 = refused, else 1 MOD, 2 XM, 3 S3M, 4 IT |
| `mp_engine()` | 1 pt2-clone, 2 ft2play, 3 it2play |
| `mp_info(k)` | 0 channels, 1 patterns, 2 orders, 3 instruments |
| `mp_name(i)` | 0 the title, 1..n instrument or sample names |
| `mp_scan(maxFrames)` | length in frames, without mixing |
| `mp_separation(pct)` | Paula stereo width for 4-channel MODs, default 20 |
| `mp_start()` | rewind |
| `mp_render(left, right, n)` | fills float buffers; fewer than `n` = ended |
| `mp_unload()` | |

`js/module-play.js` makes a new instance for every file: a damaged module can
overwrite memory inside these replayers without trapping.

## Known limits

- IT: at most 100 samples, 100 instruments and 200 patterns (Impulse
  Tracker's own limits). Files from OpenMPT that go past them are refused.
- S3M is played by Impulse Tracker's importer, not Scream Tracker 3: AdLib
  (OPL) instruments are silent.
- 4-channel MODs are a PAL Amiga (A1200 filter model, "LED" filter off until
  the song turns it on). MODs with more channels are Fasttracker's reading.
- XM instruments that hold no samples lose their names (ft2play does not keep
  them).
- A song ends the first time it re-enters an order (ft2play, it2play) or a
  row (pt2-clone) it has already played. A loop that never leaves a single
  pattern is only stopped by the caller's time limit.
- Sample rates 44100 to 96000 Hz.

Licence of `glue/` and `build.sh`: written for AudioSaw and covered by this
repository's licence, except the passages marked "from pt2-clone", which stay
under pt2-clone's BSD-3-Clause.
