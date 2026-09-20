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

## 0002-arch-dispatch-headers-for-wasm.patch

`include/zephyr/arch/cpu.h` and `include/zephyr/arch/arch_inlines.h` are
hardcoded `#elif` chains over the in-tree architectures, ending in an `#error`.
Like `GEN_ABSOLUTE_SYM`, they have no out-of-tree hook, so an architecture
shipped as a module cannot reach its own `arch.h` without editing them.

Shadowing both headers from the module was the alternative. It was rejected:
it depends on the module's include directory winning against Zephyr's own, and
it means carrying a copy of a header that changes upstream.

The same upstream fix would serve both patches: let a module contribute its
architecture to these dispatch points instead of requiring an edit in tree.

## 0003-init-entries-external-linkage-on-wasm.patch

`kernel/init.c` walks `levels[level]` to `levels[level+1]`, so every init entry
has to sit in one contiguous block ordered by level and then by priority. On
every other architecture the linker script does that, sorting input sections by
the level and priority encoded in their names. wasm-ld has no linker script and
never orders segments by name (spike A), so the block has to be built another
way: a generated file declares arrays the right size and fills them at boot by
copying each entry into its sorted position.

That copy has to name each entry, and `SYS_INIT_NAMED` and `DEVICE_DT_DEFINE`
declare them `static`. The patch makes the storage class conditional, so only
`CONFIG_WASM` changes and every other architecture keeps its internal linkage.

Nothing points *at* an init entry, so copying them is safe; what matters is
only that the entries are reachable and in order.

## 0005-ztest-bounds-through-the-section-macros.patch

ztest places its unit tests with `STRUCT_SECTION_ITERABLE` but then names the
list bounds directly, as `_ztest_unit_test_list_start` and friends. That
spelling is the one a linker script produces. On wasm there is no linker
script, and patch 0004 makes the bounds resolve to the symbols wasm-ld
synthesises for the renamed section, so the hardcoded names do not exist.

The patch routes the declarations through `TYPE_SECTION_START` and friends,
which is what the rest of Zephyr does and which produces the identical symbols
on every existing target. Worth fixing upstream for its own sake: a list
placed by the abstraction should have its bounds taken from the abstraction.
