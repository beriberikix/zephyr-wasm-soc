# NOTES — running log

## Loop state
Tick: 21 done  |  Last commit: ztest passes  |  Blocker: none

**Three of the four Milestone 2 criteria now pass.**
`tests/kernel/semaphore/semaphore` runs under ztest and all 32 tests pass,
with nothing failed or skipped:

    Running TESTSUITE semaphore
     PASS - test_k_sem_define in 0.000 seconds
    ...
    PROJECT EXECUTION SUCCESSFUL

`scripts/check_determinism.sh` exists and passes on all three builds,
including the 143 lines of ztest output.

Remaining for Milestone 2: `README.md` with the acceptance commands, verified
from a clean build directory. That is criterion 1's "with commands written up
in README.md" and is the last thing between here and a complete Milestone 2.

After that, and in the brief's order: Milestone 3 is optional, and the final
report in NOTES.md is required. Given how much has been learned, the report is
worth more than any stretch goal; do it before attempting preemption.

Tidy-ups worth doing while writing the README:

* `tests/two_threads` still prints its thread table, which was debugging
  scaffolding.
* The timer driver still carries the `isr_count`/`announced_ticks` counters
  and their export. They were useful; either keep them behind a Kconfig or
  remove them.

### Tick 20 — one bug, both symptoms

The Asyncify buffer was being placed above `stack_ptr`, in what should have
been reserved space, and was landing in the next thread's stack object
instead. Printing the extents made it obvious at a glance: one thread's buffer
base was exactly the next thread's stack base.

`ARCH_THREAD_STACK_RESERVED` is supposed to make the kernel hand over a
`stack_ptr` that already excludes the reserved bytes. Measured, it does not:
`stack_ptr` arrives at the very top of the stack object. Rather than fight
that, the buffer is now carved out from below `stack_ptr`, which keeps it
inside the thread's own object whether or not the reservation is applied, at
the cost of starting the shadow stack that much lower.

The consequence had been that unwinding any thread quietly overwrote another
thread's `k_thread` structure. That is what corrupted the timeout callback
found last tick, and it also explains the other symptom that had looked
unrelated: a static thread stuck in PRESTART. Both were the same bug. With it
fixed, static threads start on their own and the thread that was stuck reaches
the ready state.

The lesson is the one that has held for several ticks now. Two symptoms that
looked like separate scheduling faults were one memory bug, and the thing that
found it was printing four numbers per thread rather than reasoning about what
the reservation ought to do.


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
