# NOTES — running log

## Loop state
Tick: 20 done  |  Last commit: the stack split bug  |  Blocker: none

**`samples/synchronization` works.** Two threads alternate correctly, sleeps
are honoured, static threads start on their own, and two runs in virtual time
produce byte-identical output.

    *** Booting Zephyr OS build e201b84b04e4 ***
    thread_a: Hello World from cpu 0 on wasm_node!
    thread_b: Hello World from cpu 0 on wasm_node!
    thread_a: Hello World from cpu 0 on wasm_node!
    thread_b: Hello World from cpu 0 on wasm_node!

hello_world still passes and exits cleanly. That is the second of the four
Milestone 2 criteria, and the fourth is demonstrated although it still needs
the script the brief asks for.

Next:

1. Write `scripts/check_determinism.sh`, which the brief requires as its own
   deliverable. Two runs, byte-compare, non-zero exit on difference.
2. `tests/kernel/semaphore/semaphore` under ztest, the third criterion.
3. Write `README.md` with the acceptance commands, and verify them from a
   clean build directory.
4. Tidy: `tests/two_threads` still prints its thread table, which was
   debugging scaffolding. Keep the test, drop the table, or keep it behind a
   Kconfig.

### Tick 19 — the trap is a corrupted timeout callback

Three checks, and the third one found it.

The failing function contains exactly one indirect call, and disassembling it
is unambiguous: it loads a function pointer from offset 16 of a structure and
calls it with that structure as the argument. That is Zephyr's timeout
callback shape, which means the kernel is announcing ticks, finding the
sleeping thread's expired timeout, and calling a handler that is not a valid
function.

The other two checks framed it. The host confirms the failing entry is a
rewind, not a fresh call, and that the Asyncify cursor is well inside its
buffer at 60 bytes of 16 KB. So the Asyncify state is healthy and the
suspension machinery is doing its job; what is wrong is the data the kernel
reads afterwards.

That reframes the whole problem. This is not a context-switching bug and never
was. Something is overwriting a timeout structure, and timeout structures live
inside `struct k_thread`, which sits near the stack objects this port carves
in two. The next step is to stop reasoning about the split and simply print
every thread's stack base, stack pointer, buffer base and buffer end, and look
for the overlap.


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
