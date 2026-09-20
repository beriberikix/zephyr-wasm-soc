#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Spike C: Asyncify fibers.
#
# Shows several "threads", each with its own shadow-stack region and its own
# Asyncify buffer, switching under a host driver loop, then measures what the
# transform costs in size and in time.
set -euo pipefail
cd "$(dirname "$0")"
source ../../tools.env
./build.sh

echo "########## 1. four threads switching round-robin ##########"
node run.mjs fibers.async.wasm 3

echo; echo "########## 2. is each build actually instrumented? ##########"
echo "-- yield reached directly --"
for f in bench.full.wasm bench.noind.wasm bench.only.wasm bench.only2.wasm; do
  [ -f "$f" ] && node probe.mjs "$f" || true
done
echo "-- yield reached through an indirect call, as a Zephyr thread entry is --"
for f in bench.full.wasm bench.noind.wasm bench.only.wasm bench.only2.wasm; do
  [ -f "$f" ] && node probe_indirect.mjs "$f" || true
done

echo; echo "########## 3. code size ##########"
python3 - <<'PY'
import os
n = os.path.getsize
base = n('bench.base.wasm')
rows = [('bench.base.wasm', 'baseline (wasm-opt, no passes)'),
        ('bench.full.wasm', 'full asyncify'),
        ('bench.noind.wasm', 'asyncify + ignore-indirect (UNSAFE)'),
        ('bench.only2.wasm', 'asyncify + complete onlylist')]
for f, label in rows:
    if os.path.exists(f):
        s = n(f)
        print(f'  {label:<38} {s:7d} bytes  {s/base:5.2f}x  {s-base:+6d}')
PY

echo; echo "########## 4. speed of code that never yields ##########"
node bench_speed.mjs bench.base.wasm bench.full.wasm

echo; echo "########## 5. switch cost and buffer use vs stack depth ##########"
node bench_depth.mjs

echo; echo "########## 6. what a too-small buffer does ##########"
wasm-opt --asyncify --pass-arg=asyncify-imports@env.host_yield --pass-arg=asyncify-asserts \
  fibers.wasm -o fibers.asserts.wasm
node overflow.mjs fibers.async.wasm
node overflow.mjs fibers.asserts.wasm
echo; echo "########## done ##########"
