# NOTES — running log

## Loop state
Tick: 17 done  |  Last commit: threads do run  |  Blocker: none

**A second thread runs.** Starting the stuck one by hand from main produces
`a: round 0`, so the port can create, schedule and switch to another thread.
That is the first time anything other than main and idle has executed.

The stride hypothesis from tick 16 was wrong and is disproved: entries are 48
bytes apart, `sizeof(struct _static_thread_data)` is 48, and both entries read
back the right priority and a zero delay. The section layout is correct.

Two faults remain, both narrow:

1. **`z_init_static_threads` starts one thread and not the other.** Both
   entries are identical and adjacent, both read correctly, yet the first is
   left in PRESTART while the second reaches QUEUED. Instrument
   `thread_schedule_new` and `z_sched_start` per entry and find which call
   does not take effect. Note that the queued one still never ran on its own,
   so there may be a single cause behind both.
2. **A signature mismatch trap once a thread is running.** `a: round 0`
   prints, then the guest traps in an indirect call. As on tick 7, that is
   how wasm reports a call through a null or wrongly typed function pointer,
   and it names the callee rather than the site. The thread's next actions are
   `k_msleep` and `k_sem_give`, so look there, and at what happens when a
   thread entry returns.

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


### Tick 17 — a second thread runs

Starting the stuck thread by hand from main makes it run. That is worth
stating plainly: the port creates a thread, schedules it, switches to it, and
its code executes and prints. Everything the arch is responsible for on that
path works.

The stride hypothesis from last tick was wrong, and measuring it cost little:
entries sit 48 bytes apart, `sizeof` is 48, and both read back correct fields.
The section layout was never the problem. Worth recording as a small lesson in
its own right, since it was a confident-sounding theory that survived exactly
one measurement.

What is left is two specific faults rather than one vague one. The kernel's
own static-thread start path takes effect for one of two identical entries.
And once a thread is running, an indirect call traps, in the same way tick 7's
null function pointer did, which suggests looking at what happens when a
thread's work finishes rather than at the work itself.
