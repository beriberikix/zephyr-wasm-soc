#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Spike A: what does wasm-ld do with sections?
#
# Zephyr places things with a linker script: iterable sections
# (__<type>_list_start/_end), SYS_INIT levels sorted by priority in the name,
# and device ordering. wasm-ld has no linker script, so this spike asks:
#   Q1 does it synthesise __start_<sec>/__stop_<sec> for C-identifier names?
#   Q2 what order do same-named input segments end up in?
#   Q3 do dotted (non-identifier) names survive, and can they be mapped?
set -euo pipefail
cd "$(dirname "$0")"
source ../../tools.env
mkdir -p out
cc() { clang --target=wasm32-unknown-unknown -O2 -nostdlib -c "$@"; }

echo "########## Q1: __start_/__stop_ synthesis ##########"
cc q1_a.c -o out/q1_a.o; cc q1_b.c -o out/q1_b.o; cc q1_main.c -o out/q1_main.o
if wasm-ld --no-entry --export-all out/q1_a.o out/q1_b.o out/q1_main.o -o out/q1.wasm 2>out/q1.err; then
  echo "RESULT: link succeeded, wasm-ld DOES synthesise __start_zsec/__stop_zsec"
  node dump.mjs out/q1.wasm "a.o b.o"
else
  echo "RESULT: link FAILED, no __start_/__stop_ synthesis"; cat out/q1.err
fi

echo; echo "########## Q2: ordering of same-named segments ##########"
echo "--- objects given in order a,b ---"
wasm-ld --no-entry --export-all out/q1_a.o out/q1_b.o out/q1_main.o -o out/q1.wasm 2>/dev/null
node dump.mjs out/q1.wasm "link order a,b"
echo "--- objects given in order b,a ---"
wasm-ld --no-entry --export-all out/q1_b.o out/q1_a.o out/q1_main.o -o out/q1r.wasm 2>/dev/null
node dump.mjs out/q1r.wasm "link order b,a"
echo "--- from an archive, members added in reverse ---"
rm -f out/libq1.a
llvm-ar rcs out/libq1.a out/q1_b.o out/q1_a.o
wasm-ld --no-entry --export-all --whole-archive out/libq1.a --no-whole-archive out/q1_main.o -o out/q1ar.wasm 2>/dev/null
node dump.mjs out/q1ar.wasm "archive b,a"

echo; echo "########## Q2b: does wasm-ld sort by segment name? ##########"
cc q2_sort.c -o out/q2_sort.o
wasm-ld --no-entry --export-all out/q2_sort.o -o out/q2.wasm 2>/dev/null
echo "declared in source order: p90, p10, p50 (all in section 'zord')"
node dump.mjs out/q2.wasm "single object, one section"
echo "--- distinct sections, names sorted lexically? ---"
wasm-objdump -x out/q2.wasm | grep -iE "^ - segment" | head -20

echo; echo "########## Q3: dotted / non-identifier names ##########"
cc q3.c -o out/q3.o
echo "--- sections in the OBJECT ---"
llvm-objdump -h out/q3.o | sed -n '5,40p'
wasm-ld --no-entry --export-all out/q3.o -o out/q3.wasm 2>&1 | head -3
echo "--- data segments in the LINKED module ---"
wasm-objdump -x out/q3.wasm | grep -iE "^ - segment" | head -20

echo; echo "########## Q3b: renamed section, priorities out of order ##########"
cc q3b.c -o out/q3b.o
wasm-ld --no-entry --export-all out/q3b.o -o out/q3b.wasm 2>/dev/null
echo "declared in source order 90, 10, 50 -- is the linker sorting them?"
node dump.mjs out/q3b.wasm "renamed identifier section"

echo; echo "########## Q4: --defsym aliasing ##########"
cc q4.c -o out/q4.o
if wasm-ld --no-entry --export-all --defsym=__init_EARLY_start=__start_z_init_EARLY \
     out/q4.o -o out/q4.wasm 2>out/q4.err; then echo "RESULT: --defsym supported"
else echo "RESULT: wasm-ld has NO --defsym"; head -2 out/q4.err; fi

echo; echo "########## Q5: referencing a section no object defines ##########"
cc q5.c -o out/q5.o
if wasm-ld --no-entry --export-all out/q5.o -o out/q5.wasm 2>out/q5.err; then
  echo "RESULT: absent section is fine (empty range)"
else echo "RESULT: absent section is a LINK ERROR"; head -2 out/q5.err; fi

echo; echo "########## Q8: object introspection (symbol -> segment name) ##########"
wasm-objdump -x out/q3.o | sed -n '/symbol table/,/target_features/p' | head -14

echo; echo "########## Q9: are adjacent per-level arrays contiguous? ##########"
cc q9.c -o out/q9.o
wasm-ld --no-entry --export=addr --export=walk out/q9.o -o out/q9.wasm
node walk.mjs out/q9.wasm

echo; echo "########## done ##########"
