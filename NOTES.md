# NOTES — running log

## Loop state
Tick: 16 done  |  Last commit: thread states  |  Blocker: none

Listing every thread the kernel knows about, from main, is the most
informative thing done so far:

    thread thread_b   prio   7 state 0x80    <- _THREAD_QUEUED: ready
    thread thread_a   prio   7 state 0x04    <- _THREAD_PRESTART: never started
    thread idle       prio  15 state 0x00
    thread main       prio   0 state 0x80

Two distinct problems, not one.

**thread_b is ready and never runs.** It sits at priority 7, queued, while
main sleeps at priority 0 and the processor goes to idle at priority 15
instead. A queued thread being passed over for a lower-priority one points at
the ready queue or at what the scheduler believes is current, not at the
switch itself.

**thread_a never left PRESTART**, although `z_setup_new_thread` clearly ran
for it: it is in the thread list with the right name and priority. So the
second loop in `z_init_static_threads`, the one that calls
`thread_schedule_new`, reached one entry and not the other. Both are defined
identically in the same file.

Next:

1. Print `_kernel.ready_q.cache` and `arch_current_thread()` from the same
   place. If the cache does not name thread_b while thread_b is queued, the
   fault is in the queue; if it does, the fault is that nothing acts on it.
2. For thread_a, instrument the second loop of `z_init_static_threads` and
   print what `Z_THREAD_INIT_DELAY` returns per entry. One entry being
   scheduled and the next not, from the same array, suggests the second
   entry's fields are not being read correctly even though the first one's
   are.
3. That in turn suggests checking the iteration stride against
   `sizeof(struct _static_thread_data)`, since `Z_DECL_ALIGN` and whatever
   alignment wasm-ld gives the renamed section have to agree.

Item 3 is the most likely single cause of both symptoms and is worth doing
first.

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


### Tick 16 — two problems, and a probable common cause

Asking the kernel what threads it has, rather than inferring from behaviour,
split the failure in two.

One static thread is queued and ready and simply never gets the processor,
losing it to the idle thread three priority levels below. The other never left
PRESTART at all, even though it was set up correctly enough to appear in the
thread list with its right name and priority.

The second of those is the more suggestive. Both threads are defined
identically, one after the other in the same file, so they are adjacent
entries in the same iterable section. The loop that starts them reached the
first and not the second. That is the signature of an iteration stride that
does not match the layout: the first entry reads correctly because it is at
offset zero, and the next one reads garbage.

If that is right it would explain both symptoms at once, since a garbled
entry can produce a thread that is set up but never scheduled, and it would
also mean the section shim is not as verified as tick 14 concluded. Counting
entries only proves the bounds are right; it says nothing about whether the
spacing between them matches `sizeof` on the consuming side.
