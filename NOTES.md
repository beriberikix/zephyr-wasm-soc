# NOTES — running log

## Loop state
Tick: 23 done  |  Last commit: final report  |  Blocker: none

The final report is written, at the end of this file. Milestones 0, 1 and 2
are complete and Milestone 3 is untouched.

If the loop continues, the one stretch item worth doing is preemption through
safepoint instrumentation, because without it a thread that never yields
cannot be interrupted at all, which is the largest single gap between this and
something usable. The other three stretch items are conveniences.

### Tick 22 — Milestone 2 complete

The last criterion was the write-up, and doing it properly turned up nothing
new, which is the right outcome at this stage. Every command in `README.md`
was run from an empty build directory and produces the output shown next to
it.

One small thing was worth adding: `scripts/build.sh`. Every build needs four
`-D` flags, because Zephyr finds a toolchain through `TOOLCHAIN_ROOT` rather
than through the module system, and a README whose every command is six lines
long is a README nobody follows.

Also removed the debugging scaffolding that had accumulated: the thread table
the two-thread test printed, and the counters in the timer driver. Both earned
their keep, and neither belongs in the result.

---

# Final report

## What works

Zephyr runs on WebAssembly as a genuine architecture rather than a simulation.
The kernel is freestanding in one `wasm32` linear memory, with Zephyr's own
minimal libc and its own scheduler. There is no host OS inside the module and
no pthreads. The host supplies six imported functions and owns the clock.

All four Milestone 2 criteria pass from a clean checkout:

* `samples/hello_world` boots and exits cleanly.
* `samples/synchronization` alternates two threads with `k_msleep` honoured.
* `tests/kernel/semaphore/semaphore` passes all 32 tests under ztest, with
  nothing failed or skipped.
* Two runs in virtual time produce byte-identical output.

What that exercises is most of a kernel: init levels in priority order, static
and dynamic threads, context switching, semaphores, timeouts, a tickless
timer, interrupt dispatch, IRQ offload into interrupt context, and a console.

The most striking thing is how little of Zephyr objected. The kernel, the
minimal libc and both drivers compile for `wasm32` essentially untouched.
Everything that broke was at the edges: the build system, the linker, and four
places where Zephyr assumes something about its target that wasm does not
satisfy.

## The linker-section approach, and how fragile it is

wasm-ld has no linker script. It does synthesise `__start_<s>`/`__stop_<s>`
for sections whose names are C identifiers, but it never orders segments by
name, has no `--defsym`, and treats a reference to the bounds of a section
nothing defines as an error rather than an empty range.

Zephyr needs two different things from its linker script, so the port does two
different things:

**Renaming, for lists where order carries no meaning.** A patch makes
`TYPE_SECTION_ITERABLE` use a C identifier for the section name and makes the
bounds macros resolve to the synthesised symbols. No generated code at all.
This half is solid: it relies on one documented wasm-ld feature.

**Generation, for init entries.** These must form one contiguous block ordered
by level and then priority, because `z_sys_init_run_level` walks from one
level's start symbol to the next. No amount of renaming achieves that. A build
step reads the compiled objects, recovers each entry's level and priority from
the segment name Zephyr already encodes, and emits per-level arrays filled at
boot by copying each entry into its sorted place. Copying is safe because
nothing holds a pointer to an init entry.

How fragile: the renaming half is solid. The generated half rests on three
conventions rather than guarantees. Zephyr must keep encoding level and
priority in the section name. wasm-ld must keep placing same-named segments in
link order. And the objects the scanner reads are a *superset* of what reaches
the image, because Zephyr's pay-per-use linkage means a section can be defined
in an object the link discards. That last one is the sharp edge, and it cost
two rounds of wrong fixes: a weak fallback for a section that does exist
suppresses the real bounds and silently empties the list.

Two failure modes are quiet. A list that reads as empty produces no error,
just a subsystem that never initialises. And a zero-length array in a section
may not be emitted at all, leaving its symbol pointing at whatever the linker
put there instead, which is how one init level's range came to swallow
another's entries.

## Asyncify overhead

Code size, on the three real builds:

| Build | Linked | After Asyncify | Ratio |
|---|---|---|---|
| hello_world | 311794 | 329909 | 1.06x |
| synchronization | 321434 | 341433 | 1.06x |
| semaphore tests | 500998 | 612006 | 1.22x |

The spread is informative. Asyncify instruments only what can transitively
reach a suspending import, so the cost tracks how much of the image can
suspend. ztest's larger share reflects a test suite where almost everything
can block.

Speed, measured on a synthetic kernel-shaped module in spike C: code that
never yields runs at 1.00x. Twenty thousand rounds of sixty indirect calls
took 9.9 ms instrumented and 9.9 ms not. The instrumentation is paid for in
size, not throughput.

A switch costs about 200 ns plus 12 ns per live frame, and the buffer needs
about 88 bytes plus 32 per frame. Both scale with stack depth at the moment of
the yield, because Asyncify copies the live frames.

Narrowing the transform does not help and is dangerous. Both `ignore-indirect`
and an onlylist naming only the yielding leaf produce modules that run
straight past a yield reached through an indirect call, which is how Zephyr
reaches thread entries, init handlers and ISRs. A *correct* onlylist, naming
every frame that can be live, costs exactly what the full pass costs.

The real cost is not the code size. It is that every thread reserves a buffer
whether or not it ever suspends deeply, and that buffer is not bounds-checked:
Asyncify writes past the end silently, with no trap, even with
`asyncify-asserts`.

## Kernel features disabled

Six, all in `boards/wasm/wasm_node/wasm_node_defconfig`, and all for the same
reason: they read or produce ELF.

| Kconfig | Why |
|---|---|
| `GEN_ISR_TABLES` | The generator reads the linked ELF; the port uses a software table with dynamic interrupts. |
| `DEVICE_DEPS` | Needs a second link stage and a numeric sort wasm-ld cannot do. |
| `BUILD_OUTPUT_BIN` | An objcopy step, meaningless for a wasm module. |
| `OUTPUT_STAT` | A readelf step. |
| `OUTPUT_PRINT_MEMORY_USAGE` | Parses ELF section sizes. |
| `CHECK_INIT_PRIORITIES` | Reads the linked ELF's symbol table. |

Two more are worth listing though they are not disabled features:
`ATOMIC_OPERATIONS_C` is replaced by the builtin form, since the C
implementation drags in syscall headers and a single linear memory with no SMP
needs nothing stronger; and `GEN_ABSOLUTE_SYM_KCONFIG` is made a no-op,
because its callers pass names that are themselves macros, which only works
with a form that stringifies before expansion.

`CONFIG_USERSPACE`, MPU, MMU and SMP were out of scope from the start.

Nothing was turned off to make a test pass.

## What the stack-switching proposal would change

Most of the arch would not change at all. Switching already goes through one
internal interface, so a typed-continuations backend replaces `switch.c` and
the host's Asyncify loop and nothing else.

What would go away:

* **The buffer, and the stack split.** Each thread would need only its shadow
  stack, so `ARCH_THREAD_STACK_RESERVED` would drop to zero and the sizing
  question disappears. That also removes the silent-overflow hazard and the
  bug that cost the most time here, where one thread's buffer landed in
  another thread's stack object.
* **The size cost.** No instrumentation pass, so no 1.06x to 1.22x, and no
  question about narrowing it.
* **The host's role in switching.** A module cannot switch its own stack under
  Asyncify: every switch unwinds to the host and is rewound from there. With
  stack switching the kernel would switch directly, `arch_switch()` would look
  like every other port's, and the switch block in linear memory would not
  exist.
* **The noreturn restriction.** Asyncify cannot suspend inside a function
  declared never to return, because there is no resume point past a call the
  compiler has been told never comes back. That is why this port cannot use
  `ARCH_HAS_CUSTOM_SWAP_TO_MAIN`.

What would not change: the cooperative interrupt model, the host-as-SoC ABI,
virtual time, and the entire linker-section problem, which is about wasm-ld
and not about how stacks are switched.

## The biggest obstacles to upstreaming

**Zephyr assumes an architecture is in-tree.** Four of the five patches are
this one gap wearing different hats. `GEN_ABSOLUTE_SYM` is a per-architecture
`#elif` chain ending in `#error`. So are `cpu.h`, `arch_inlines.h` and
`exception.h`. None has an out-of-tree hook, so an architecture shipped as a
module cannot reach its own headers without editing the tree. This is the
single most valuable thing to fix upstream, and it would benefit any new
architecture, not just this one.

**Zephyr assumes a linker script exists.** The build fails outright if
`LINKER_SCRIPT` does not name a file, with no "no linker script" path. Section
placement is the deeper version of the same assumption. A target where the
linker cannot order or name sections needs a supported way to supply those
symbols, rather than each port inventing a generator.

**Some list bounds are spelled by hand.** ztest names
`_ztest_unit_test_list_start` directly while placing entries through
`STRUCT_SECTION_ITERABLE`. Patch 0005 routes those through the macros, which
produces identical symbols everywhere and is worth taking on its own merits:
a list placed by an abstraction should take its bounds from that abstraction.

**The offsets header is ELF-shaped by construction.** `gen_offset_header.py`
reads `SHN_ABS` symbols. Wasm has no absolute symbols, and the inline-asm
`.equ` every architecture uses is a hard LLVM backend failure rather than a
graceful one. The mechanism, not just the parser, needs a portable form.

**Twister cannot describe this board.** Its platform schema has a closed
`arch` enum with no `wasm`, so the board cannot be declared honestly.

None of these is deep. They are all the same shape: reasonable assumptions,
made once, that an unusual target reveals. What makes this port interesting is
how much of Zephyr turned out not to depend on them.

## What I would tell someone starting this again

Measure before fixing. The last ten ticks of this log divide cleanly into ones
where I measured something and learned the answer, and ones where I fixed
something plausible and learned nothing. Two symptoms that looked like separate
scheduler faults were one memory bug, and what found it was printing four
numbers per thread rather than reasoning about what a macro ought to do.

Make the failures loud. Dropping `--allow-undefined` was the single most useful
change in the build: unresolved symbols had been turning into imports that
failed much later with a message naming neither the symbol nor the reason.

And a wasm-specific note worth keeping: a null function pointer here is table
slot zero, so calling one is an indirect call with the wrong type, and the
engine reports a signature mismatch naming the callee. A class of bug that is a
wild jump elsewhere surfaces as a type error at the call site, which is more
useful once you know to read it that way.
