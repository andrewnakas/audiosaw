#!/bin/bash
# Builds openrb.wasm from a pinned commit of OpenRB-338 and the wrapper crate
# in ./crate. Needs: git, the network (the clone and seven small crates from
# crates.io) and a Rust toolchain with the wasm32-unknown-unknown target
# (built with rustc 1.97.1; `rustup target add wasm32-unknown-unknown`).
# Homebrew's cargo has no wasm target: put rustup's toolchain first on PATH.
#
# It lives beside crate/ and patches/ and writes ./openrb.wasm. The clone and
# cargo's output go in ./work, or in $OPENRB_WORK if that is set (about
# 250 MB); delete it afterwards.
set -euo pipefail
cd "$(dirname "$0")"
HERE="$(pwd)"

OPENRB_COMMIT=8bd0dcc9ac386cf58342435872033fe8b4227829

WORK="${OPENRB_WORK:-$HERE/work}"
rm -rf "$WORK"
mkdir -p "$WORK"

git init -q "$WORK/upstream"
git -C "$WORK/upstream" remote add origin https://github.com/pingw33n/OpenRB-338
git -C "$WORK/upstream" fetch -q --depth 1 origin "$OPENRB_COMMIT"
git -C "$WORK/upstream" -c advice.detachedHead=false checkout -q FETCH_HEAD
git -C "$WORK/upstream" apply "$HERE/patches/rbm-external-assets.patch"

# The patch gives the rbm crate a feature that leaves ReBirth's material out.
# These two files are what it leaves out; deleting them proves the build does
# not read them (include_bytes! of a missing file is a compile error).
rm "$WORK/upstream/assets/Standard.rbm" "$WORK/upstream/crates/rbm/src/rb20ful_window.bin"

# crate/Cargo.toml names ../upstream, so the crate is built from beside it.
cp -R "$HERE/crate" "$WORK/crate"

# Panic messages carry source paths: without the remaps the wasm would hold
# this machine's directory names.
export CARGO_TARGET_DIR="$WORK/target"
export RUSTFLAGS="--remap-path-prefix=$WORK=/openrb --remap-path-prefix=${CARGO_HOME:-$HOME/.cargo}=/cargo"
# upstream's rust-toolchain.toml is not consulted from here: cargo runs in
# ./work/crate, which is not inside the checkout.
(cd "$WORK/crate" && cargo build --release --locked --target wasm32-unknown-unknown -j "${OPENRB_JOBS:-4}")

cp "$WORK/target/wasm32-unknown-unknown/release/openrb.wasm" "$HERE/openrb.wasm"
ls -l "$HERE/openrb.wasm"
