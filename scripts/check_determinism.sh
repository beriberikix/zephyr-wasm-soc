#!/usr/bin/env bash
# Run a module twice in virtual time and require byte-identical output.
#
# Virtual time is the point of the default host mode: the clock only advances
# when the kernel idles, and then it jumps straight to the next deadline, so
# nothing in a run depends on how fast the machine underneath it happens to
# be. This checks that claim rather than asserting it.
#
# Usage: check_determinism.sh <zephyr.wasm> [extra run.mjs args...]
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
wasm="${1:?usage: check_determinism.sh <zephyr.wasm> [args...]}"
shift || true

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

for run in 1 2; do
  # stdout only: the trace goes to stderr and is not part of the contract.
  node "$here/../host/run.mjs" "$@" "$wasm" > "$tmp/run$run.out" 2>/dev/null || true
done

if cmp -s "$tmp/run1.out" "$tmp/run2.out"; then
  lines=$(wc -l < "$tmp/run1.out" | tr -d ' ')
  echo "deterministic: two runs produced identical output ($lines lines)"
  exit 0
fi

echo "NOT deterministic: the two runs differ" >&2
diff "$tmp/run1.out" "$tmp/run2.out" | head -20 >&2
exit 1
