#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Build the spike C modules.
#
# Note: link with wasm-ld directly, not through the clang driver. The driver
# drops the wasm "name" section, and without names Binaryen cannot match an
# asyncify onlylist -- it warns and then silently instruments nothing.
set -euo pipefail
cd "$(dirname "$0")"
source ../../tools.env

CFLAGS=(--target=wasm32-unknown-unknown -O2 -nostdlib -c)

clang "${CFLAGS[@]}" fibers.c -o fibers.o
wasm-ld --no-entry --allow-undefined \
  --export=thread_main --export=arena_base --export=slot_bytes \
  --export=stack_bytes --export=nthreads --export=set_yield_depth --export=__stack_pointer \
  fibers.o -o fibers.wasm
wasm-opt --asyncify --pass-arg=asyncify-imports@env.host_yield fibers.wasm -o fibers.async.wasm

clang "${CFLAGS[@]}" bench.c -o bench.o
wasm-ld --no-entry --allow-undefined \
  --export=compute --export=yielding --export=__stack_pointer \
  bench.o -o bench.wasm
# Baseline: wasm-opt rewrites the module even with no passes, so compare
# against that rather than the raw link output.
wasm-opt bench.wasm -o bench.base.wasm
wasm-opt --asyncify --pass-arg=asyncify-imports@env.host_yield bench.wasm -o bench.full.wasm
# ignore-indirect drops instrumentation for anything only reached indirectly.
# Unsafe here, and kept only to show that it is.
wasm-opt --asyncify --pass-arg=asyncify-imports@env.host_yield \
  --pass-arg=asyncify-ignore-indirect bench.wasm -o bench.noind.wasm
# An onlylist naming only the yielding leaf: also wrong, for the same reason.
wasm-opt --asyncify --pass-arg=asyncify-imports@env.host_yield \
  --pass-arg=asyncify-onlylist@yielding bench.wasm -o bench.only.wasm
# A complete onlylist: every frame that can be live across a yield.
wasm-opt --asyncify --pass-arg=asyncify-imports@env.host_yield \
  --pass-arg=asyncify-onlylist@yielding,sleeper,compute bench.wasm -o bench.only2.wasm
