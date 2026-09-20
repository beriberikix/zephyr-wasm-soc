# DESIGN — arch/wasm for Zephyr

A record of decisions and the host ABI. Findings, measurements and dead ends
live in `NOTES.md`; the task statement lives in `BRIEF.md`.

## 1. Scope and shape

The kernel is built as a freestanding `wasm32-unknown-unknown` module. It owns
one linear memory. There is no host OS inside the module: no pthreads, no
`arch/posix`, no native_sim. Zephyr's own libc and scheduler are used.

The host (Node.js, `host/run.mjs`) plays the role of a SoC. Everything the
kernel would reach through memory-mapped registers is instead an imported
function in a single import module named `zephyr_host`.

Out of scope, as set by the brief: `CONFIG_USERSPACE`, MPU/MMU, SMP,
networking, Bluetooth, browsers, the stack-switching backend, upstreaming.

## 2. Decisions

### D1. Workspace layout
The module repo `zephyr-wasm/` is both the west manifest repo and the Zephyr
module. Zephyr is pinned in `west.yml` to main commit `e201b84b` (v4.4.99).
No Zephyr modules are imported; the port needs no HAL and uses the minimal libc.

### D2. Toolchain
Homebrew LLVM (clang + wasm-ld, matched versions) driven through a module-owned
toolchain variant `wasm-clang`. The Zephyr SDK's clang has no wasm32 target and
Apple clang ships no wasm-ld, so neither is usable as a pair.

`TOOLCHAIN_ROOT` is a single path and is not a `module.yml` setting, so the
module supplies the whole set: `cmake/toolchain/wasm-clang/`,
`cmake/compiler/wasm-clang/`, `cmake/linker/wasm-ld/`, `cmake/bintools/wasm/`.

### D3. Context switching: Asyncify, behind one interface
Switching goes through a single internal interface (`wasm_ctx_*` in
`arch/wasm/include/`), so a stack-switching backend can replace it later
without touching the rest of the arch. Backend chosen for this PoC: Binaryen
Asyncify.

### D4. Interrupts: cooperative, checked at safepoints
A pending-IRQ word in linear memory is set by the host and checked at
safepoints. `arch_irq_lock()` masks delivery rather than disabling anything in
the engine. Minimum safepoint is `arch_cpu_idle()`; loop back-edges come later
via an instrumentation pass (Milestone 3).

### D5. Determinism by default
The host runs on virtual time. When the kernel idles, the host jumps straight
to the next deadline. `--realtime` opts out.

## 3. Host ABI: import module `zephyr_host`

To be filled in as Milestone 1 lands. Sketch:

| Import | Signature | Purpose |
|---|---|---|
| `console_write` | `(ptr: i32, len: i32) -> ()` | console / printk char-out |
| `time_now_ns` | `() -> i64` | monotonic clock |
| `set_alarm_ns` | `(deadline: i64) -> ()` | program the next timer interrupt |
| `wait_for_event` | `() -> ()` | idle; suspension point under Asyncify |
| `fatal` | `(reason: i32, arg: i32) -> ()` | unrecoverable error |

Traps kill the instance and cannot be recovered from: a Wasm trap unwinds to
the host with no way back into the module. Fatal errors therefore go through
the `fatal` import, not through a trap, so the host can print a diagnosis.

### D6. Linker sections: renaming where order is free, generation where it is not

Spike A (`spikes/a-sections/`) showed wasm-ld synthesises `__start_`/`__stop_`
for C-identifier section names but never orders segments by name, has no
`--defsym`, and errors out on a reference to a section nothing defines.

The port therefore splits the problem:

**Unordered families use renaming.** For iterable sections whose order carries
no meaning, the module shadows the naming macros so the section name is a C
identifier, and takes `__start_`/`__stop_` as the list bounds. This covers
most of `STRUCT_SECTION_ITERABLE`. Because an absent section breaks the link,
each family the kernel references gets one anchor entry emitted by the module.

**Ordered families are generated.** Init entries cannot work this way:
`z_sys_init_run_level` in `kernel/init.c` walks `levels[level]` to
`levels[level+1]`, so all entries must be one contiguous block sorted by level
then priority. Instead a build step reads the pass-1 objects, recovers each
entry's level and priority from the segment name Zephyr already encodes
(available in the `linking` custom section), sorts, and emits a C file that
defines the six per-level arrays adjacently in one translation unit. Spike A
question 9 confirmed those land contiguous in declaration order and that the
kernel's own walk then visits the right entries, so `kernel/init.c` needs no
patch.

Device order is left as link order. With `CONFIG_DEVICE_DEPS=n` the device
list is only iterated and bounded, never indexed by devicetree ordinal, so the
numeric sort the ELF build does is not needed. This is a PoC simplification
and is the first thing to revisit if device lookup misbehaves.

How fragile this is: the renaming half is solid, since `__start_`/`__stop_` is
a documented wasm-ld feature. The generated half depends on two things that
are conventions rather than guarantees: Zephyr keeping level and priority
encoded in the section name, and wasm-ld keeping declaration order within a
translation unit. Both are stable in practice, and both fail loudly rather
than silently if they change.

### D7. Offsets header: constants as data, read from assembly

Wasm has no absolute symbols, and the inline-asm `.equ` that every other
architecture uses for `GEN_ABSOLUTE_SYM` is a hard LLVM backend failure, not a
graceful one (spike B). The port emits each constant as real data in a
`z_offsets` section and recovers the value from the compiler's assembly
output, where it is a label followed by `.int32`. `scripts/gen_offsets_wasm.py`
replaces `scripts/build/gen_offset_header.py`, substituted by redefining
`zephyr_constants_library` from `arch/wasm/CMakeLists.txt`, which the root
`CMakeLists.txt` reaches before it declares the offsets library.

Reading assembly rather than the object was chosen deliberately: it is one
regex over output the compiler is obliged to produce, where the alternatives
are scraping two `wasm-objdump` reports or writing a wasm binary parser.

Struct layout has to come from the target compiler. For one representative
struct the host reports 32 bytes and wasm32 reports 16, so compiling
`offsets.c` natively, as the brief warns, would be wrong by a factor of two.

### D8. Thread stack split, and why the full Asyncify pass

Spike C settles the shape of a thread. Each `K_THREAD_STACK` object is split
in two: the low part is the C shadow stack that `__stack_pointer` walks, and
the high part is the Asyncify buffer holding unwound wasm frames. A switch
swaps both, because Asyncify saves the wasm frames but does not touch
`__stack_pointer`. wasm-ld exports that global and the host can write it.

Sizing comes from the measurements: the buffer needs about 88 bytes plus 32
per frame live at the moment of the yield. The reserved split will be a
Kconfig with a conservative default, because a buffer that is too small does
not fail cleanly. Asyncify does not bounds-check it. In the spike a 248 byte
buffer absorbed 1112 bytes and carried on, silently overwriting whatever
followed, and `asyncify-asserts` does not add a bounds check. The port places
the buffer at the top of the stack object so an overflow runs into the next
guard rather than into live thread state.

The port uses the **full** Asyncify pass, not `ignore-indirect` and not an
onlylist. Both narrowing options break the case Zephyr depends on: a yield
reached through an indirect call, which is how thread entries, init handlers
and ISR table entries are all reached. In the spike those builds ran straight
past the yield instead of suspending. A correct onlylist, naming every frame
that can be live across a yield, turns out to cost exactly what the full pass
costs anyway, because Binaryen already instruments only what can reach a
suspending import. There is nothing to win.

The measured cost is 1.22x code size on a kernel-shaped module, and no
measurable throughput cost on code that does not yield. A switch is about
200 ns plus 12 ns per live frame.

### D9. Link with wasm-ld directly

The clang driver drops the wasm name section. Nothing in the kernel needs it,
but Binaryen does: without names an asyncify onlylist silently matches nothing
and produces a module that never suspends. The toolchain files invoke wasm-ld
directly so names survive and any future narrowing stays possible.

## 4. Kernel features forced off

Every Kconfig this port forces off, with the reason. Filled in as they are hit.

| Kconfig | Why |
|---|---|
| `DEVICE_DEPS` | Device dependency arrays need a second link stage and a numeric sort wasm-ld cannot do. Off also keeps the build single-stage. |
| `GEN_ISR_TABLES` | The generator reads the linked ELF. The port uses a software ISR table with dynamic interrupts instead. |
| `USERSPACE` | Out of scope per the brief, and its gperf passes are ELF-only. |
| `SYMTAB` | Generator reads the linked ELF. |
| `BUILD_OUTPUT_BIN` | objcopy step, meaningless for a wasm module. |
| `OUTPUT_STAT` | readelf step. |
| `OUTPUT_PRINT_MEMORY_USAGE` | Parses ELF section sizes. |
| `CHECK_INIT_PRIORITIES` | Reads the linked ELF's symbol table. |
| `ATOMIC_OPERATIONS_C` | Not off so much as replaced by the builtin form. The C implementation drags in syscall headers, and a single linear memory with no SMP needs nothing stronger than the compiler builtins. |
| `GEN_ABSOLUTE_SYM_KCONFIG` | Not a Kconfig, but recorded here: made a no-op by patch 0001. Its callers pass names that are themselves macros, which only works with the stringifying assembly form. Nothing reads the resulting symbols at run time. |

All of the above are set in `boards/wasm/wasm_node/wasm_node_defconfig`.

## 5. Changes to the Zephyr tree

The Zephyr tree is read-only. Anything unavoidable becomes a numbered patch in
`patches/` with a comment, applied by `scripts/apply_patches.sh`.

**0001-toolchain-gen-absolute-sym-for-wasm.patch.** `GEN_ABSOLUTE_SYM` in
`include/zephyr/toolchain/gcc.h` is a per-architecture chain ending in
`#error processor architecture not supported`. There is no generic fallback and
no out-of-tree hook, so a new architecture cannot compile `offsets.c` without
being listed in that file. The patch adds a `CONFIG_WASM` branch that emits the
constant as data. Worth fixing upstream by giving the macro a generic
data-emitting default.
