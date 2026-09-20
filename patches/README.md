# Patches to the Zephyr tree

The Zephyr tree is treated as read-only. Everything this port needs lives in
the module, with one exception recorded here. Apply them with
`scripts/apply_patches.sh`, which is idempotent.

## 0001-toolchain-gen-absolute-sym-for-wasm.patch

`GEN_ABSOLUTE_SYM` in `include/zephyr/toolchain/gcc.h` is a chain of
per-architecture branches that ends in `#error processor architecture not
supported`. There is no generic fallback and no out-of-tree hook, so any new
architecture has to appear in that chain or it cannot compile `offsets.c`
at all.

Every existing branch emits an inline-asm `.equ`, which creates an absolute
symbol. WebAssembly has no absolute symbols: spike B showed the LLVM wasm
backend fails with "absolute addressing not supported" rather than degrading.
The added branch emits the constant as real data instead, which
`scripts/gen_offsets_wasm.py` reads back.

This is the kind of thing worth fixing upstream: the macro wants a generic
data-emitting fallback so a new architecture does not need to touch this file.
