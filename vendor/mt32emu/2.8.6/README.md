# mt32emu.wasm

Munt's **libmt32emu 2.8.6**, a Roland MT-32 / CM-32L emulator, compiled to one
standalone WebAssembly file. AudioSaw loads it through `/js/mt32-core.js`.

- Upstream: https://github.com/munt/munt, directory `mt32emu`
- Commit: `91d2205eb8f2591d177b257b92e2c75f830508de` (tag `libmt32emu_2_8_6`)
- Library source: unmodified
- Compiler: Emscripten 6.0.10 (`em++`)
- SHA-256 of `mt32emu.wasm`: `fd2cb8612c03a23c34ca0ea38592888e891c407ff012085c7faa55893583ef14`
  (running `build.sh` twice with that compiler gave the same bytes)

No ROM data is in this file or anywhere on the site. The emulator plays
nothing until you give it a control ROM and a PCM ROM of your own. They stay
in your browser.

## Licence

libmt32emu is Copyright (C) 2003-2009 Dean Beeler, Jerome Fisher and
Copyright (C) 2011-2026 Dean Beeler, Jerome Fisher, Sergey V. Mikayev. It is
free software under the GNU Lesser General Public License, version 2.1 or (at
your option) any later version. The full text is in `COPYING.LESSER` here.
There is no warranty.

`mt32emu_wasm.cpp`, the small wrapper that gives the module its exported C
functions, is under the same licence.

`mt32emu.wasm` is the library and that wrapper and nothing else. The rest of
AudioSaw only calls its exported functions.

## Using your own build

The site never links this file into anything: `js/mt32-core.js` takes the
module as bytes on every call. To use a changed or newer libmt32emu:

1. Edit the library, or change `COMMIT` and the version numbers in `build.sh`.
2. Run `./build.sh` (needs `git` and Emscripten's `em++`). It fetches exactly
   that commit, compiles it with `mt32emu_wasm.cpp`, and writes `mt32emu.wasm`
   next to itself.
3. Give the result to the page in place of ours: serve the site yourself with
   your file at this path, or call
   `ASMt32.render(yourWasmBytes, { control, pcm }, events)` from the console.

Any build works as long as it exports the functions listed below.

## What the module is

- Imports (both may be functions that do nothing):
  - `env.emscripten_notify_memory_growth(i32)`
  - `wasi_snapshot_preview1.fd_write(i32, i32, i32, i32) -> i32`
    (the library can print a consistency warning; return 0 and store the
    byte count)
- No threads, no filesystem, no clock, no random numbers.
- Memory: 16 MB to start, grows as needed, 256 MB at most. Stack: 1 MB.
- Call `_initialize()` once after instantiating.

Exports (see the comments in `mt32emu_wasm.cpp`):

| Function | Does |
|---|---|
| `malloc(n)`, `free(p)` | memory for ROMs, sysex and output |
| `mt32_version()` | `"2.8.6"` |
| `mt32_identify(ptr, len)` | 1 if the bytes are a known ROM, by size and SHA-1 |
| `mt32_info_type()` | 0 PCM, 1 control |
| `mt32_info_pair()` | 0 whole, 1 first half, 2 second half, 3 even bytes, 4 odd bytes |
| `mt32_info_id()`, `mt32_info_desc()`, `mt32_info_sha1()` | C strings |
| `mt32_known(i)` | selects the i-th known ROM for the `mt32_info_*` calls; 0 past the end |
| `mt32_create()` | a context |
| `mt32_add_rom(ctx, ptr, len)` | 1 control ready, 2 PCM ready, 3 / 4 half taken, -1 unknown, -7 halves do not match. The bytes must stay allocated until `mt32_close` |
| `mt32_open(ctx, analog, renderer)` | 0 ok, -4 a ROM is missing, -7 control and PCM are from different machines, -100 refused. `analog` 0 digital only, 1 coarse; `renderer` 0 integer, 1 float |
| `mt32_rate(ctx)` | 32000 |
| `mt32_play_msg(ctx, msg, frame)` | a short message (`status \| d1 << 8 \| d2 << 16`) at an output frame; 1 queued, 0 queue full |
| `mt32_play_sysex(ctx, ptr, len, frame)` | a whole `F0 ... F7` message |
| `mt32_render(ctx, floatPtr, frames)` | interleaved stereo float |
| `mt32_active(ctx)` | 1 while a voice or the reverb still sounds |
| `mt32_close(ctx)` | frees everything |

## What is left out of the build

`FileStream.cpp` (ROMs arrive as memory), `MidiStreamParser.cpp` (events
arrive one at a time), `SampleRateConverter.cpp` and the `srchelper` resamplers
(output is at the machine's own 32 kHz; the page resamples), and
`c_interface` (it links the three above). The 48 kHz and 96 kHz analogue
output modes are therefore not offered.

## ROMs the library accepts

Identified by SHA-1, so a patched or badly dumped ROM is refused.

- Control: MT-32 v1.04, v1.05, v1.06, v1.07, "BlueRidge", v2.03, v2.04, v2.06,
  v2.07; CM-32L / LAPC-I v1.00, v1.02; CM-32LN / CM-500 / LAPC-N v1.00.
- PCM: MT-32 (512 KB); CM-32L / CM-64 / LAPC-I (1 MB).
- Halves, as dumped chip by chip: the two interleaved 32 KB halves of the
  v1.04-v1.07 and BlueRidge control ROMs, the two 256 KB halves of the MT-32
  PCM ROM, and the two 512 KB halves of the CM-32L PCM ROM.

A control ROM only opens with the PCM ROM of its own machine.

## Checked by

`node tools/check-mt32.js`. With `MT32_ROMS=/dir` pointing at your own ROM
pair it also renders notes and measures them.
