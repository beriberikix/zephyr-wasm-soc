#!/usr/bin/env bash
# Apply the patches this port needs to the Zephyr tree. Idempotent: a patch
# that is already applied is skipped, not reapplied.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
zephyr="${ZEPHYR_BASE:-$(cd "$here/../../zephyr" && pwd)}"
echo "Zephyr tree: $zephyr"
for p in "$here"/../patches/*.patch; do
  name="$(basename "$p")"
  if git -C "$zephyr" apply --reverse --check "$p" >/dev/null 2>&1; then
    echo "  already applied: $name"
  elif git -C "$zephyr" apply --check "$p" >/dev/null 2>&1; then
    git -C "$zephyr" apply "$p"; echo "  applied: $name"
  else
    echo "  ERROR: $name does not apply cleanly to $zephyr" >&2; exit 1
  fi
done
