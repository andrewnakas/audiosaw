# openrb 2026-11-13

One standalone WebAssembly file that renders ReBirth RB-338 songs (`.rbs`) to
PCM, used by `js/rebirth-play.js` (`ASRebirth`) and checked by
`node tools/check-rebirth.js`.

## What is inside

The engine and file-format crates of
[OpenRB-338](https://github.com/pingw33n/OpenRB-338), a reimplementation of
ReBirth RB-338 2.01 whose export equals the original's byte for byte.
Copyright (C) 2026 the OpenRB-338 authors, GPL-3.0-only (`LICENSE` here is its
`LICENSE`, the GPLv3 text).

| | |
|---|---|
| Pinned commit | `8bd0dcc9ac386cf58342435872033fe8b4227829` (2026-11-13, the folder's name) |
| Crates compiled | `rbs` (the song formats), `orb-engine` (the two TB-303s, TR-808, TR-909, mixer, delay, distortion, PCF, compressor, sequencer), `rbm` (mods) |
| Their dependencies | `libm` 0.2.16 (pinned by upstream: the tables), `toml` 0.9.12 and `sha2` 0.10.9 (`rbm`; nearly all of both is dropped by the linker) |
| Wrapper | `crate/`, written for AudioSaw, GPL-3.0-only like what it links |
| Not compiled | `orb-cli`, `orb-player`, `orb-ui`: the command line, the audio device, the encoders, the panel |

The file is 312,788 bytes and imports nothing.

**Nothing of ReBirth is in it.** Upstream compiles two things of
Propellerhead's into its programs: `assets/Standard.rbm` (ReBirth's 46 drum
samples and its panel pictures) and `crates/rbm/src/rb20ful_window.bin` (2,047
bytes of the ReBirth CD's `RB20FUL.DAT`, the key that recrypted mods are
scrambled against). This build has neither: `build.sh` deletes both files from
the checkout before compiling, and both arrive as bytes at run time if the
caller has them. Neither is in this repository, and no song is.

ReBirth RB-338 is a trademark of Propellerhead Software (now Reason Studios).
This is not affiliated with or endorsed by them, and neither is OpenRB-338.

## Changes to upstream

One patch, `patches/rbm-external-assets.patch`, 34 added lines in the `rbm`
crate and none in the engine:

- a cargo feature `external-assets`, off by default, under which the two
  `include_bytes!` above become empty stand-ins;
- `KeyTable::with_window(rbm, window)`: upstream's `KeyTable::embedded` with
  the key bytes passed in.

The engine (`orb-engine`) and `rbs` compile for `wasm32-unknown-unknown`
unchanged. Upstream's own web build is still planned (its backlog task 169);
what that task asks to be proven is what `tools/check-rebirth.js` measures:
the wasm render equals the native `orb render` sample for sample.

`crate/src/lib.rs` repeats three small pieces of `orb-cli`, which cannot be
linked (it brings the audio device and the encoders): `drums_playing` and the
choice of samples from `render.rs`, the song facts from `info.rs`, and the
steps of `export::export`, split so that the audio comes out a few chunks per
call.

## Build

`./build.sh` (git, the network, Rust with the `wasm32-unknown-unknown` target;
built here with rustc 1.97.1, where upstream's `rust-toolchain.toml` names
1.99.1). It clones the commit above into `./work` (or `$OPENRB_WORK`), applies
the patch, deletes the two ReBirth files, and runs, in a copy of `crate/`:

```
RUSTFLAGS="--remap-path-prefix=$WORK=/openrb --remap-path-prefix=$CARGO_HOME=/cargo"
cargo build --release --locked --target wasm32-unknown-unknown -j 4
```

with, from `crate/Cargo.toml`: `opt-level = 3`, `lto = "fat"`,
`codegen-units = 1`, `panic = "abort"`, `strip = true`. `crate/Cargo.lock` has
upstream's versions of the shared dependencies.

No threads, no SharedArrayBuffer, no filesystem, no wasm-bindgen, no JS glue.
The remaps keep the build machine's directory names out of the panic
messages. Two builds in differently named work folders came out 8 bytes
apart, so the file is not byte-reproducible; both pass the check.

Nothing is run through `wasm-opt`.

## Exports

`memory`, and:

| Export | |
|---|---|
| `orb_alloc(n)`, `orb_free(p, n)` | wasm heap |
| `orb_rate()` | 44100 |
| `orb_load_song(ptr, len)` | 0 = refused, 1 = RBS 4.x, 2 = ReBirth 1.x |
| `orb_info()` | the song's facts as JSON (NUL-terminated UTF-8) |
| `orb_frames(startTick, endTick, cap)` | the export's length in frames, counted no further than `cap`; both ticks `0xFFFFFFFF` = the song's loop |
| `orb_set_key(ptr, 2047)` | the key bytes a `.rbm` needs |
| `orb_set_kit(ptr, len)`, `orb_set_mod(ptr, len)` | the standard kit and the song's mod: a recrypted `.rbm` (after `orb_set_key`) or a clear kit |
| `orb_kit_name(which)` | the INFO name of the kit (0) or the mod (1) |
| `orb_begin(startTick, endTick, idleBlocks)` | new engine, load, idle blocks, locate, play; returns flags (1 kit used, 2 mod used, 4 drums silent for want of samples, 8 the song's mod was not given, 16 the mod has gaps and there is no kit, 32 the mod is not the one named) or -1 |
| `orb_render(out, frames)` | whole 2048-frame chunks of interleaved int16 into `out`; 0 = finished |
| `orb_end()` | ends the export; the number of render calls that faulted |
| `orb_export_kit(which)`, `orb_out()` | the loaded kit as a clear kit: length, pointer |
| `orb_blank_song()` | an empty RBS 4.2 song at `orb_out()`, for the check |
| `orb_message()` | the last failure's text |
| `orb_panic_text()` | where a panic's text is left (512 bytes) |

`js/rebirth-play.js` makes a new instance for every file.

## What it renders

What `orb render` renders, which is what the original's File > "Export Loop
as Audio File" writes: **the song's loop**, the bars between the two loop
markers saved in the file, whether or not the loop is switched on. Not the
song from its first bar to its last: an `.rbs` has no length, and the original
plays on to bar 1000. `orb render --range START:END` renders other bars, and
`ASRebirth.render(..., { range: [start, end] })` is the same thing.

The length is the export's own arithmetic (upstream `export::chunk_sizes`, the
original's `sub_4280D5`): chunks of 2048 frames, each moving the position on
by `tempo * frames * 192 / 2646000000` ticks (tempo in thousandths of a BPM,
768 ticks to a bar), and a last chunk of whatever is left, truncated. Four
bars at 140 BPM are 302,399 frames, not 302,400.

Before the first chunk the engine runs 9,088 blocks of 64 frames with the
transport stopped (13.2 s that are not in the output). That is `orb render`'s
default `--idle-blocks`; the effects start from the state they have then.

Output: 44.1 kHz, 16-bit stereo. That is the engine's native and only format.

## The clear kit

A `.rbm` is scrambled, and reading one needs the 2,047 key bytes. A clear kit
is the same 46 sample slots as plain PCM, and needs nothing:

```
"ORBKIT1\0"
u16 LE n, n bytes       the kit's name (a mod's INFO name), UTF-8
46 times, slots 1000..1045 (24 TR-808, Startup, 21 TR-909):
  u32 LE frames         0xFFFFFFFF = no sample here (the standard kit's plays)
  frames * i16 LE       mono, 44.1 kHz
```

`node make-kit.js MOD.rbm rb20ful_window.bin OUT.orbkit` writes one
(`ASRebirth.clearKit`). The panel pictures of the `.rbm` are left out. The
result is still the mod author's, or Propellerhead's, samples.

## Known limits

- The loop, or a range of bars; there is no "whole song" in the format.
  `range: 'song'` in `js/rebirth-play.js` is bar 0 to the bar of the last
  track event, a guess of AudioSaw's.
- A pattern-mode song renders as the engine's song-mode render of its loop
  (upstream warns: the original cannot export one).
- Mods must be recrypted (`orb mod recrypt`, which needs the ReBirth CD's
  `RB20FUL.DAT`), or clear kits. The mods of github.com/pingw33n/rb-mods are
  recrypted already. A mod changes the drum sounds only.
- No real-time playing, no editing, no saving.
- A file damaged in the right place makes the engine panic (an index past a
  table in `tb303.rs` or `frame/mod.rs`, about 1 in 100 of the files
  `check-rebirth.js` damages). That is a trap, which `js/rebirth-play.js`
  turns into its ordinary "damaged file" Error.

## Licence

GPL-3.0-only: `LICENSE`. The corresponding source of `openrb.wasm` is the
upstream repository at the pinned commit, `patches/`, `crate/` and `build.sh`.
