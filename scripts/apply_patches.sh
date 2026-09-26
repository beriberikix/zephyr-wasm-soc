#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Apply the patches this port needs. Idempotent: a patch that is already
# applied is skipped, not reapplied.
#
# patches/*.patch go to the Zephyr tree. patches/<module>/*.patch go to that
# Zephyr module, which west checks out under modules/: today only picolibc.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
patches="$here/../patches"
zephyr="${ZEPHYR_BASE:-$(cd "$here/../../zephyr" && pwd)}"
topdir="$(cd "$zephyr/.." && pwd)"

apply_to() {
  local tree="$1"; shift
  echo "$(basename "$tree"): $tree"
  for p in "$@"; do
    name="$(basename "$p")"
    if git -C "$tree" apply --reverse --check "$p" >/dev/null 2>&1; then
      echo "  already applied: $name"
    elif git -C "$tree" apply --check "$p" >/dev/null 2>&1; then
      git -C "$tree" apply "$p"; echo "  applied: $name"
    else
      echo "  ERROR: $name does not apply cleanly to $tree" >&2; exit 1
    fi
  done
}

apply_to "$zephyr" "$patches"/*.patch
# A module west has not checked out is an error rather than a skip: every
# module with patches here is in west.yml, so a missing one means the
# workspace is not what the build expects.
apply_to "$topdir/modules/lib/picolibc" "$patches"/picolibc/*.patch
