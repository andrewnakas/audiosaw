#!/bin/sh
# Rebuilds mt32emu.wasm from Munt's libmt32emu at the exact commit below.
# Needs git and emscripten (em++ on PATH, or EMXX=/path/to/em++).
# Usage: ./build.sh [work-dir]      (default: a fresh temp dir)
# The result is written next to this script as mt32emu.wasm.
set -eu

COMMIT=91d2205eb8f2591d177b257b92e2c75f830508de   # tag libmt32emu_2_8_6
VERSION=2.8.6
HERE=$(cd "$(dirname "$0")" && pwd)
WORK=${1:-$(mktemp -d)}
EMXX=${EMXX:-em++}

mkdir -p "$WORK"
if [ ! -d "$WORK/munt/.git" ]; then
  git init -q "$WORK/munt"
  git -C "$WORK/munt" remote add origin https://github.com/munt/munt.git
fi
git -C "$WORK/munt" fetch -q --depth 1 origin "$COMMIT"
git -C "$WORK/munt" checkout -q --detach FETCH_HEAD
test "$(git -C "$WORK/munt" rev-parse HEAD)" = "$COMMIT"

SRC="$WORK/munt/mt32emu/src"
GEN="$WORK/gen"
mkdir -p "$GEN"

# What cmake would generate from src/config.h.in for a static, C++-API build.
cat > "$GEN/config.h" <<CFG
#ifndef MT32EMU_CONFIG_H
#define MT32EMU_CONFIG_H
#define MT32EMU_VERSION      "$VERSION"
#define MT32EMU_VERSION_MAJOR 2
#define MT32EMU_VERSION_MINOR 8
#define MT32EMU_VERSION_PATCH 6
#define MT32EMU_EXPORTS_TYPE 0
#define MT32EMU_WITH_VERSION_TAGGING 0
#undef MT32EMU_RUNTIME_VERSION_CHECK
#endif
CFG

# The library's own source list (CMakeLists.txt, libmt32emu_CPP_SOURCES) less
# FileStream.cpp, MidiStreamParser.cpp and SampleRateConverter.cpp: ROMs come
# as memory, events come one at a time, and output is at the native rate.
SOURCES="Analog BReverbModel Display File LA32FloatWaveGenerator LA32Ramp
  LA32WaveGenerator Part Partial PartialManager Poly ROMInfo Synth Tables
  TVA TVF TVP sha1/sha1"
FILES=""
for s in $SOURCES; do FILES="$FILES $SRC/$s.cpp"; done

# The stack is 1 MB, not emscripten's 64 KB: Synth::render keeps six
# 4096-sample buffers on it (48 KB as integers, 96 KB as floats) and more
# below that.
"$EMXX" -O2 -std=c++11 -fno-exceptions -fno-rtti \
  -I"$GEN" -I"$SRC" \
  $FILES "$HERE/mt32emu_wasm.cpp" \
  --no-entry \
  -sSTACK_SIZE=1048576 \
  -sSTANDALONE_WASM=1 \
  -sALLOW_MEMORY_GROWTH=1 \
  -sINITIAL_MEMORY=16777216 \
  -sMAXIMUM_MEMORY=268435456 \
  -sFILESYSTEM=0 \
  -sEXPORTED_FUNCTIONS=_malloc,_free \
  -o "$HERE/mt32emu.wasm"

ls -l "$HERE/mt32emu.wasm"
