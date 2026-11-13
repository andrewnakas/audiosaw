#!/bin/bash
# Builds modplay.wasm from pinned commits of 8bitbubsy's replayers.
# Needs: git, emscripten (built with emcc 6.0.10) and the network. It lives
# beside glue/ and patches/ and writes ./modplay.wasm. The clones and objects
# go in ./work, or in $MODPLAY_WORK if that is set; delete it afterwards.
set -euo pipefail
cd "$(dirname "$0")"
HERE="$(pwd)"

FT2PLAY_COMMIT=39af5ccd8cb7d6cdb8a74c0307c73841750b2c37
IT2PLAY_COMMIT=c8fefba91ba2709cd959a6c66bbbb554399bd12b
PT2CLONE_COMMIT=80aff083768b04c3ad765c71e01d88593d424855

WORK="${MODPLAY_WORK:-$HERE/work}"
rm -rf "$WORK"
mkdir -p "$WORK/glue"
cp -R glue/. "$WORK/glue/"

fetch() { # name commit
  git init -q "$WORK/$1"
  git -C "$WORK/$1" remote add origin "https://github.com/8bitbubsy/$1"
  git -C "$WORK/$1" fetch -q --depth 1 origin "$2"
  git -C "$WORK/$1" -c advice.detachedHead=false checkout -q FETCH_HEAD
  # the sources are CRLF, and so are the patches
  if [ -f "$HERE/patches/$1.patch" ]; then
    git -C "$WORK/$1" apply --whitespace=nowarn "$HERE/patches/$1.patch"
  fi
}
fetch ft2play "$FT2PLAY_COMMIT"
fetch it2play "$IT2PLAY_COMMIT"
fetch pt2-clone "$PT2CLONE_COMMIT"   # unpatched

cd "$WORK"
COMMON="-O2 -DNDEBUG -fno-strict-aliasing -include glue/mp_driver.h -Wno-everything -c"
OBJ="$WORK/obj"
mkdir -p "$OBJ"
cc() { # prefix, extra flags, files...
  local prefix="$1" flags="$2"; shift 2
  for f in "$@"; do
    emcc $COMMON $flags "$f" -o "$OBJ/$prefix$(basename "$f" .c).o"
  done
}

cc mp_ "" glue/modplay.c

# ft2play. pmp_mix.c is compiled inside glue_ft2.c, which includes it; the
# SDL/WinMM drivers and the command-line player are left out.
cc ft2_ "" glue/glue_ft2.c \
  ft2play/pmplay.c ft2play/pmp_main.c ft2play/snd_masm.c ft2play/tables.c

# it2play. it2drivers/hq.c is compiled inside glue_it2.c.
cc it2_ "" glue/glue_it2.c \
  it2play/it_music.c it2play/it_m_eff.c it2play/it_d_rm.c it2play/it_structs.c it2play/it_tables.c \
  it2play/loaders/it.c it2play/loaders/s3m.c it2play/loaders/mmcmp/mmcmp.c \
  it2play/it2drivers/hq_m.c it2play/it2drivers/hq_fixsample.c it2play/it2drivers/zerovol.c \
  it2play/it2drivers/sb16.c it2play/it2drivers/sb16_m.c \
  it2play/it2drivers/sb16mmx.c it2play/it2drivers/sb16mmx_m.c \
  it2play/it2drivers/wavwriter.c it2play/it2drivers/wavwriter_m.c

# pt2-clone: only the replayer, the Paula mixer, the tables and the two MOD
# loaders. glue_pt2.c replaces its SDL audio layer and UI, and glue/sdlstub
# stands in for <SDL2/SDL.h>, which its headers include. Its global "song"
# has the same name as ft2play's, so it is renamed for these files.
cc pt2_ "-Iglue/sdlstub -Dsong=pt2_song" glue/glue_pt2.c \
  pt2-clone/src/pt2_replayer.c pt2-clone/src/pt2_paula.c pt2-clone/src/pt2_blep.c \
  pt2-clone/src/pt2_rcfilters.c pt2-clone/src/pt2_downsample2x.c pt2-clone/src/pt2_tables.c \
  pt2-clone/src/pt2_structs.c \
  pt2-clone/src/modloaders/pt2_load_mod31.c pt2-clone/src/modloaders/pt2_load_mod15.c

# Exports come from export_name attributes in glue/modplay.c.
emcc -O2 "$OBJ"/*.o -o "$HERE/modplay.wasm" \
  --no-entry -sSTANDALONE_WASM=1 \
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=16MB -sMAXIMUM_MEMORY=2GB \
  -sSTACK_SIZE=1MB -sMALLOC=emmalloc -sFILESYSTEM=0 -Wl,--error-limit=0

ls -l "$HERE/modplay.wasm"
