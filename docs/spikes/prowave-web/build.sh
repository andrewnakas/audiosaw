#!/bin/sh
# Builds the Pro Wave web spike. Usage: build.sh <scratch dir>
# Needs: rustup stable with wasm32-unknown-unknown, wasm-bindgen-cli 0.2.129 (the lock's version).
set -eu
S="$1"; HERE="$(cd "$(dirname "$0")" && pwd)"
export PATH="$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin:$HOME/.cargo/bin:$PATH"
export CARGO_TARGET_DIR="$S/target"
if [ ! -d "$S/p1" ]; then
  git clone --depth 1 --branch v0.2.2 https://github.com/fabox-os/Pro-Wave "$S/p1"   # 03e1abda
  python3 -I "$HERE/apply.py" "$S/p1"
fi
cd "$S/p1"
# The workspace's release profile is fat LTO in one codegen unit; these make the spike build
# finish on a loaded machine. Drop them for a size-optimised build.
export CARGO_PROFILE_RELEASE_LTO="${PROWAVE_LTO:-false}"
export CARGO_PROFILE_RELEASE_CODEGEN_UNITS="${PROWAVE_CGU:-16}"
export CARGO_PROFILE_RELEASE_OPT_LEVEL="${PROWAVE_OPT:-2}"
cargo build -j 3 --release -p prowave-app --target wasm32-unknown-unknown
mkdir -p "$HERE/dist"
wasm-bindgen --target web --no-typescript --out-dir "$HERE/dist" --out-name prowave \
  "$CARGO_TARGET_DIR/wasm32-unknown-unknown/release/prowave.wasm"
cp "$HERE/index.html" "$HERE/dist/index.html"
cp "$S/p1/LICENSE" "$HERE/dist/LICENSE"
ls -l "$HERE/dist"
