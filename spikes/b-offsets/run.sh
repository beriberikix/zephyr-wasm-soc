#!/usr/bin/env bash
# Spike B: produce offsets.h without ELF.
#
# Zephyr generates offsets.h by reading SHN_ABS symbols from an ELF object,
# which wasm has no equivalent for. This spike establishes what replaces it.
set -euo pipefail
cd "$(dirname "$0")"
source ../../tools.env
mkdir -p out
cc() { clang --target=wasm32-unknown-unknown -O2 -nostdlib "$@"; }

echo "########## Q1: can wasm do ELF-style absolute symbols at all? ##########"
if cc -c q1_elfstyle.c -o out/q1.o 2>out/q1.err; then
  echo "RESULT: unexpectedly compiled"; llvm-nm out/q1.o
else
  echo "RESULT: no. The backend rejects it:"
  grep -o "absolute addressing not supported.*" out/q1.err | head -1
fi

echo; echo "########## Q2: constants in a data section, read from -S output ##########"
../../scripts/gen_offsets_wasm.py -i offsets_sample.c -o out/offsets.h \
  --compiler clang --flag=--target=wasm32-unknown-unknown --flag=-O2 --flag=-nostdlib
echo "--- generated header ---"
sed -n '/#define/p' out/offsets.h | sed 's/^/  /'

echo; echo "########## Q3: do the values match the real wasm32 layout? ##########"
cc -Wl,--no-entry -Wl,--export=v verify.c -o out/verify.wasm
node verify.mjs

echo; echo "########## Q4: host layout would have been wrong ##########"
cc() { :; }
cc_host() { clang -O2 "$@"; }
cat > out/hostcheck.c <<'EOF'
#include <stdio.h>
typedef struct { void *sp; void *asyncify_buf; } _callee_saved_t;
typedef struct { _callee_saved_t callee_saved; void *init_data; char prio; unsigned char flags; } _thread_t;
int main(void) { printf("  host: sizeof(_thread_t)=%zu offsetof(prio)=%zu\n",
    sizeof(_thread_t), __builtin_offsetof(_thread_t, prio)); return 0; }
EOF
clang -O2 out/hostcheck.c -o out/hostcheck && ./out/hostcheck
echo "  wasm32: sizeof(_thread_t)=16 offsetof(prio)=12  (from the header above)"
echo "  -> compiling offsets.c natively would produce wrong numbers, as the brief warns"

echo; echo "########## done ##########"
