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

## 5. Changes to the Zephyr tree

The Zephyr tree is read-only. Anything unavoidable becomes a numbered patch in
`patches/` with a comment. Currently: none.
