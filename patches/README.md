# Patches to the Zephyr tree, and to picolibc

The Zephyr tree is treated as read-only. Everything this port needs lives in
the module, with the exceptions recorded here. The numbered patches in this
directory are to Zephyr; `picolibc/` holds two to that module, described at
the end. Apply them all with `scripts/apply_patches.sh`, which is idempotent.

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

## 0004-iterable-sections-identifier-names-on-wasm.patch

`STRUCT_SECTION_ITERABLE` puts each entry in a section named
`._<family>.static.<key>_`, and the ELF linker scripts collect every family
with `SORT_BY_NAME`, so a list is contiguous and in key order. Some code
depends on the order: zbus names a channel's observations so that sorting
groups them by channel and puts them in notification priority, and
`_zbus_init` works out each channel's range from that.

wasm-ld has no linker script and never sorts by name. On wasm the patch names
the section `z_iter_<family>.<key>_`, keeping the same key, and points the
list bounds at `__start_z_iter_<family>` and `__stop_z_iter_<family>`.
`scripts/gen_sections_wasm.py` defines those and lays the family out in key
order (`DESIGN.md` D6), and `scripts/check_sections_wasm.py` checks the result
in the link map.

The first version of this patch dropped the key and let wasm-ld synthesise the
bounds for an identifier-named section, on the assumption that these lists do
not depend on order. Seven zbus samples showed that they do.

## 0005-ztest-bounds-through-the-section-macros.patch

ztest places its unit tests with `STRUCT_SECTION_ITERABLE` but then names the
list bounds directly, as `_ztest_unit_test_list_start` and friends. That
spelling is the one a linker script produces. On wasm there is no linker
script, and patch 0004 makes the bounds resolve to symbols the module's
section generator defines, so the hardcoded names do not exist.

The patch routes the declarations through `TYPE_SECTION_START` and friends,
which is what the rest of Zephyr does and which produces the identical symbols
on every existing target. Worth fixing upstream for its own sake: a list
placed by the abstraction should have its bounds taken from the abstraction.

## 0006-twister-know-about-wasm.patch

Twister validates every board's metadata against
`scripts/schemas/twister/platform-schema.yaml`, whose `arch` field is a closed
enum of the in-tree architectures. An out-of-tree architecture therefore
cannot describe itself honestly: the board either names an architecture it is
not, or fails validation.

The patch adds `wasm` to the list. That is the smallest possible fix and also
shows the shape of the real one: the enum should come from the architectures
actually present, the same way `list_hardware.py` already discovers them,
rather than being written out by hand.

## 0007-device-api-ext-end-on-wasm.patch

`Z_DEVICE_API_EXT_END` names a symbol the linker script produces by grouping a
device API class's section with the sections of any classes extending it, and
marking the end of the whole group. Grouping sections is exactly what wasm-ld
cannot do.

The patch uses the end of the class's own section instead. That is exact when
nothing extends the class, which holds for every API class in this port's
builds. It is not a general fix: with an extended class, `DEVICE_API_IS()`
would fail to recognise the child. Recorded as a limitation rather than
presented as equivalent.

This is the fourth patch caused by the same underlying thing, that Zephyr
expects a linker that can order and group sections.

## 0008-cbprintf-cxx-long-double-check-on-wasm.patch

Every log call packs its arguments with cbprintf, and the packing macro
asserts at compile time that no argument is a `long double` unless
`CBPRINTF_PACKAGE_LONGDOUBLE` is set. The assertion only matters where a
`long double` is aligned more strictly than a `double`. In C it tests the
argument with `_Generic`. In C++ it calls a template function, which is not a
constant expression, so on those targets every log call in C++ fails to
compile.

Zephyr already handles this with a list in `cbprintf_internal.h`: on
x86_64, riscv and aarch64, the C++ test is skipped. wasm32's `long double` is
binary128 with 16-byte alignment, the same case, and the patch adds `__wasm__`
to the list. Without it, CHRE and `logging/syst`'s deferred C++ variants do
not compile.

It is another per-architecture list with no hook for an architecture outside
the tree. Upstream could make the function `constexpr` and drop the list.

## 0009-twister-cases-from-output-when-not-elf.patch

Before it runs a ztest suite, twister lists its test cases by reading the
ztest symbols from the image's ELF symbol table. A WebAssembly image is not an
ELF file, so `ELFFile()` raised and twister abandoned the whole run before
building anything else. With the patch it skips that step when the image is
not ELF, and takes the cases from the console output, which its ztest harness
parses anyway.

The one thing lost is the list of cases compiled out of a build. Twister
reports those as having no status rather than leaving them out, a warning and
not a failure. The upstream fix would read a WebAssembly image's names too,
or let a board say how its images are inspected.

## 0010-thread-info-stack-pointer-on-wasm.patch

`CONFIG_DEBUG_THREAD_INFO` publishes the offsets a debugger needs to walk
the kernel's threads, and one of them, where a thread's saved stack pointer
is, comes from a per-architecture chain in `subsys/debug/thread_info.c` that
ends in `#warning`. `philosophers` turns the option on. The sweep builds it
with the warning, but twister builds with warnings as errors, so there it
did not build. The patch adds wasm, whose saved stack pointer is the C
shadow stack's, `callee_saved.sp`.

Another per-architecture list with no hook for an architecture outside the
tree, like 0001, 0002 and 0008.

## picolibc/0001-exitprocs-no-fini-array-on-wasm.patch

Picolibc registers the function that runs `atexit()` handlers by putting a
pointer to it in a section named `.fini_array_onexit`, whenever
`__INIT_FINI_ARRAY` is set, and its CMake build always sets it. Clang's
WebAssembly backend refuses any section whose name starts with `.fini_array`
("fini_array sections are unsupported"), so one file in picolibc does not
compile for wasm32 and nothing links.

The patch leaves the entry out on wasm. Nothing is lost: Zephyr never runs
the fini array on any architecture, so on every target an `atexit()` handler
is registered and never called. This is the one change picolibc needs for
wasm32, and it belongs upstream in picolibc.

## picolibc/0002-libm-build-every-long-double-source-with-CMake.patch

Picolibc has two builds, meson and CMake, and Zephyr uses the CMake one. Its
list of `long double` sources in `newlib/libm/ld` is written out by hand, and
six files the meson build compiles are missing from it, `s_fpclassifyl.c`
among them. Picolibc's own `<math.h>` calls `__fpclassifyl` for
`fpclassify()`, `isnan()` and friends on a `long double`, so anything that
reaches one through the CMake-built library fails to link. libc++ does, when
it formats a `long double`, which on wasm32 is binary128.

The patch adds the six, so both builds provide the same functions. C builds
from the module do not change: nothing they link calls these. It belongs
upstream in picolibc, and is not specific to wasm.
