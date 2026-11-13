#!/bin/sh
# Rebuilds vendor/msfa/<date>/dx7.wasm for AudioSaw from a pinned Dexed commit.
# Needs git and emscripten (built with em++ 6.0.10). Run from anywhere:
#   sh build.sh                      -> $TMPDIR/dx7-build/out/dx7.wasm
#   DX7_BUILD_DIR=/some/dir sh build.sh
# The wrapper/ directory (dx7_wasm.cc and shim/) must sit next to this script.
# Nothing is written beside the script, so it can run from the vendor folder.
set -eu

DEXED_REPO=https://github.com/asb2m10/dexed.git
DEXED_COMMIT=fea2f0f0f2c397799f59b27eb11c038cd34b22c5   # 2026-10-14

HERE=$(cd "$(dirname "$0")" && pwd)
BUILD="${DX7_BUILD_DIR:-${TMPDIR:-/tmp}/dx7-build}"
SRC="$BUILD/src"
WORK="$BUILD/work"
OUT="$BUILD/out"
mkdir -p "$BUILD"

if [ ! -d "$SRC/.git" ]; then git clone --quiet "$DEXED_REPO" "$SRC"; fi
git -C "$SRC" checkout --quiet "$DEXED_COMMIT"

# Only Source/msfa, unmodified, and only the Apache-2.0 files. tuning.h and
# tuning.cc are left behind (no licence header, need JUCE); wrapper/shim has a
# stand-in. The copy matters: controllers.h includes "../debugger/Logger.h"
# relative to itself, and in Dexed's tree that is a JUCE header.
rm -rf "$WORK" && mkdir -p "$WORK/msfa" "$WORK/debugger" "$OUT"
MSFA_CC="dx7note.cc env.cc exp2.cc fm_core.cc fm_op_kernel.cc freqlut.cc lfo.cc pitchenv.cc porta.cpp sin.cc"
MSFA_H="aligned_buf.h controllers.h dx7note.h env.h exp2.h fm_core.h fm_op_kernel.h freqlut.h lfo.h module.h pitchenv.h porta.h sin.h synth.h"
for f in $MSFA_CC $MSFA_H; do
  grep -q 'Apache License, Version 2.0' "$SRC/Source/msfa/$f" || { echo "not Apache-2.0: $f" >&2; exit 1; }
  cp "$SRC/Source/msfa/$f" "$WORK/msfa/$f"
done
cp "$HERE/wrapper/shim/msfa/tuning.h" "$HERE/wrapper/shim/msfa/libMTSClient.h" "$WORK/msfa/"
cp "$HERE/wrapper/shim/debugger/Logger.h" "$WORK/debugger/"
mkdir -p "$WORK/sys" && cp "$HERE/wrapper/shim/iostream" "$WORK/sys/"
cp "$HERE/wrapper/dx7_wasm.cc" "$WORK/"

SOURCES="$WORK/dx7_wasm.cc"
for f in $MSFA_CC; do SOURCES="$SOURCES $WORK/msfa/$f"; done

# -fno-exceptions/-fno-rtti and no <iostream>: nothing may pull in a WASI file
# import, because the module is instantiated inside an AudioWorklet from bytes.
em++ -O2 -std=c++17 -fno-exceptions -fno-rtti \
  -I "$WORK/sys" -I "$WORK/msfa" \
  $SOURCES \
  --no-entry -sSTANDALONE_WASM=1 \
  -sALLOW_MEMORY_GROWTH=0 -sINITIAL_MEMORY=2097152 -sSTACK_SIZE=65536 \
  -sMALLOC=emmalloc -sFILESYSTEM=0 \
  -sEXPORTED_FUNCTIONS=_malloc,_free \
  -o "$OUT/dx7.wasm"

ls -l "$OUT/dx7.wasm"
