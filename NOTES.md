# NOTES — running log

## Loop state
Tick: 22 done  |  Last commit: Milestone 2 complete  |  Blocker: none

**Milestone 2 is complete.** All four acceptance criteria pass, from clean
build directories, using only the commands written up in `README.md`:

1. `samples/hello_world` prints the banner and greeting, exit 0.
2. `samples/synchronization` alternates two threads with `k_msleep` honoured.
3. `tests/kernel/semaphore/semaphore` passes all 32 tests under ztest.
4. Two runs produce byte-identical output; `scripts/check_determinism.sh`
   checks it.

`scripts/build.sh` wraps the flags every build needs, so the README commands
are two lines each rather than six.

Next, and in this order:

1. **The final report**, which the brief requires in `NOTES.md`: what works,
   the linker-section approach and how fragile it is, Asyncify overhead
   numbers, every kernel feature disabled, what the stack-switching proposal
   would change, and the biggest obstacles to upstreaming. Everything it needs
   is already recorded in this log and in `DESIGN.md`; it is a matter of
   drawing it together rather than new investigation.
2. Only then Milestone 3, which is explicitly optional. Preemption through
   safepoint instrumentation is the most valuable of its four items, because
   without it a thread that never yields cannot be interrupted at all.

### Tick 21 — ztest, and a second upstream-shaped patch

ztest needed one patch and one missing arch function.

**The patch is the same shape as the ztest-independent ones before it.** ztest
places its unit tests, suites and rules with `STRUCT_SECTION_ITERABLE`, and
then names the list bounds directly, as `_ztest_unit_test_list_start` and so
on. That spelling is what a linker script produces. There is no linker script
here, so those symbols do not exist; patch 0004 makes the bounds resolve to
what wasm-ld synthesises for the renamed section. Routing the declarations
through `TYPE_SECTION_START` and friends fixes it and produces identical
symbols on every existing target. It is worth fixing upstream on its own
merits: a list placed by an abstraction should take its bounds from that
abstraction.

**IRQ offload was the missing function.** ztest uses it to run code in
interrupt context. There is no way to raise a real interrupt here and none is
needed: interrupts are already delivered by calling handlers from a safepoint,
so running the routine with the nesting count raised is exactly what the
dispatcher does. Eight lines.

All 32 semaphore tests pass, and the 143 lines of output are byte-identical
across runs.


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
