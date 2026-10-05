#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Run Zephyr's twister against the wasm_node board.
#
# Twister finds boards, SoCs and architectures in the modules it discovers,
# and discovery reads west's projects, which leave out the manifest repository
# -- this module. ZEPHYR_EXTRA_MODULES adds it, as scripts/build.sh does for
# west build, and the same toolchain arguments go to every build. Twister then
# runs each image through the board's `run` target (cmake/run_wasm.cmake).
#
# It needs Zephyr's test requirements, which the build does not:
#   pip install -r zephyr/scripts/requirements-run-test.txt \
#               -r zephyr/scripts/requirements-build-test.txt
#
# scripts/check_samples.py and scripts/check_kernel.py remain the record; this
# is for running the same suites the way upstream does.
#
# Usage: scripts/twister.sh [twister args...]   e.g. -T zephyr/tests/kernel/semaphore
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
module="$(cd "$here/.." && pwd)"
topdir="$(cd "$module/.." && pwd)"
source "$module/tools.env"

export ZEPHYR_BASE="${ZEPHYR_BASE:-$topdir/zephyr}"
export ZEPHYR_EXTRA_MODULES="$module"
export ZEPHYR_TOOLCHAIN_VARIANT=wasm-clang
export TOOLCHAIN_ROOT="$module"

cd "$topdir"
exec python3 "$ZEPHYR_BASE/scripts/twister" -p wasm_node \
  -x TOOLCHAIN_ROOT="$module" \
  -x ZEPHYR_TOOLCHAIN_VARIANT=wasm-clang \
  -x WASM_MODULE_DIR="$module" \
  -x ZEPHYR_EXTRA_MODULES="$module" \
  "$@"
