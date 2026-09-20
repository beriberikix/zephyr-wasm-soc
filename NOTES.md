# NOTES — running log

## Loop state
Tick: 15 done  |  Last commit: minimal reproducer  |  Blocker: none

There is now a minimal reproducer in the tree, `tests/two_threads`, and it
isolates the fault sharply.

    west build -b wasm_node -d build-two zephyr-wasm/tests/two_threads -- <flags>
    node zephyr-wasm/host/run.mjs build-two/zephyr/zephyr.wasm

    *** Booting Zephyr OS build e201b84b04e4 ***
    main: sleeping so the lower-priority threads can run
    main: done

Two threads defined with `K_THREAD_DEFINE`, one holding a semaphore so it can
run immediately, and neither ever runs. Main sleeps 200 ms to give them the
processor and wakes correctly, so sleeping and waking work; the threads simply
never become schedulable.

Also established: the sample's threads hand off explicitly through semaphores,
so none of this depends on time slicing. And in `samples/synchronization` the
thread that does run is the one created dynamically from main, while the
static one never runs. So the distinction is not static versus dynamic
definition but when the thread is made ready: threads readied during early
boot never run, threads readied later do.

Next:

1. Read `z_init_static_threads` in `kernel/init.c` and follow exactly what it
   does to a thread with zero delay, through `k_thread_start` and
   `z_ready_thread`, and find which step does not take effect here.
2. Check the ready queue directly: after boot, walk `_kernel.ready_q` and see
   whether the static threads are in it. That separates "never made ready"
   from "ready but never chosen".
3. If they are in the queue, the fault is in the switch contract; compare
   `arch_new_thread`'s handling of `switch_handle` against the contract at the
   top of `kernel/include/kswap.h`.

### Tick 14 — the sections are right; it is the scheduler

A single measurement settled where the remaining fault is not. Counting the
entries the kernel actually walks at boot gives exactly one static thread,
which is exactly what the sample defines.

So the renaming survives the link, the bounds resolve to the real section, and
the generated fallbacks stay out of the way. Everything the section shim is
responsible for is working. The fault is downstream, in getting a ready thread
onto the processor.

Worth noting as method rather than result: this is the third tick in a row
where the useful move was to measure one thing precisely rather than to fix
something plausible. The two generator bugs found last tick were real, and
neither was the cause.


### Tick 15 — a reproducer, and what it rules out

`samples/synchronization` was doing too many things at once to be a good
second test: static and dynamic threads, two semaphores, a busy wait and a
sleep. `tests/two_threads` in this repo does one thing, and prints at every
stage so the output says how far the port gets.

Two threads defined with `K_THREAD_DEFINE`, one already holding its
semaphore, and neither runs. Main sleeps to hand over the processor and wakes
on time, which confirms once more that sleeping and waking work.

What this rules out is useful. It is not time slicing: the threads hand off
explicitly, and the sample's do too, which was worth checking before blaming
the port. It is not the section shim, verified last tick. It is not the timer
or the wake path, both exercised by main's own sleep in this very test.

What it leaves is narrow: a thread made ready during early boot never runs,
while one made ready later does. That is the difference between the static
threads here and the dynamic thread that works in the sample.
