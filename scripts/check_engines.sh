#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Run one module on both hosts and require byte-identical output.
#
# host/run.mjs is V8 and host/run_wasmtime.py is Cranelift, and the two are
# deliberately separate implementations of the same ABI rather than one
# harness with two back ends. That independence is the whole value: if they
# agree, neither the port nor its determinism depends on one engine.
#
# The README has always quoted that result as a measurement taken once. This
# makes it a check, so it stays true.
#
# Usage: check_engines.sh <zephyr.wasm> [extra args for both hosts...]
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
wasm="${1:?usage: check_engines.sh <zephyr.wasm> [args...]}"
shift || true

python="${PYTHON:-python3}"
if ! "$python" -c "import wasmtime" 2>/dev/null; then
  echo "check_engines: the wasmtime module is not installed for $python" >&2
  echo "  $python -m pip install wasmtime" >&2
  exit 127
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# stdout only: the wasmtime host writes no trace and the Node one may.
node "$here/../host/run.mjs" "$@" "$wasm" > "$tmp/node.out" 2>/dev/null || true
"$python" "$here/../host/run_wasmtime.py" "$@" "$wasm" > "$tmp/wasmtime.out" 2>/dev/null || true

if cmp -s "$tmp/node.out" "$tmp/wasmtime.out"; then
  lines=$(wc -l < "$tmp/node.out" | tr -d ' ')
  echo "engine-neutral: V8 and wasmtime produced identical output ($lines lines)"
  exit 0
fi

echo "NOT engine-neutral: the two hosts differ" >&2
diff "$tmp/node.out" "$tmp/wasmtime.out" | head -20 >&2
exit 1
