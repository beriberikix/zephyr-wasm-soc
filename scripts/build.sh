#!/usr/bin/env bash
# Build an application for the wasm_node board.
#
# The flags below have to be passed on every build: the module supplies its own
# toolchain variant, and Zephyr looks for the toolchain files under
# TOOLCHAIN_ROOT rather than through the module system.
#
# Usage: scripts/build.sh <build-dir> <app-path> [extra cmake args...]
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
module="$(cd "$here/.." && pwd)"
topdir="$(cd "$module/.." && pwd)"
source "$module/tools.env"

build_dir="${1:?usage: build.sh <build-dir> <app-path> [cmake args...]}"
app="${2:?usage: build.sh <build-dir> <app-path> [cmake args...]}"
shift 2

cd "$topdir"
west build -b wasm_node -d "$build_dir" "$app" -- \
  -DTOOLCHAIN_ROOT="$module" \
  -DZEPHYR_TOOLCHAIN_VARIANT=wasm-clang \
  -DWASM_MODULE_DIR="$module" \
  -DZEPHYR_EXTRA_MODULES="$module" \
  "$@"
