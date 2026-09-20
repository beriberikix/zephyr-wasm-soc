# NOTES — running log

## Loop state
Tick: 14 done  |  Last commit: static thread list verified  |  Blocker: none

hello_world still passes. `samples/synchronization` still emits one line.

**The section work is now verified correct.** Counting the entries the kernel
walks at boot gives exactly one static thread, which is what the sample
defines. So the list is populated, the renamed section survives the link, and
the bounds resolve. That rules out the whole section mechanism as the cause
and was worth establishing before going further.

What is left is scheduling: a thread that is on the ready queue is never
switched to. The suspect is the one part of the switch contract this port has
never checked against the kernel's expectations, in `kernel/include/kswap.h`:

* `arch_new_thread()` publishes `thread->switch_handle = thread`, and
  `z_wasm_switch()` publishes the outgoing thread the same way. Read the
  contract at the top of `kswap.h` and confirm both are what it asks for,
  particularly whether `switch_handle` must be NULL while a thread is running
  and non-NULL only when it is safe to switch to.
* Check what the scheduler thinks is ready: print
  `_kernel.ready_q.cache` and `arch_current_thread()` around a switch.
* The sample's two threads share a priority, so also confirm whether it
  depends on time slicing, which this port does not have until the safepoint
  work in Milestone 3. If it does, the sample may be the wrong second test
  and something with an explicit handoff would prove switching sooner.

That last point matters: it is worth five minutes to check the sample's
threads really do hand off explicitly before assuming the port is at fault.

### Tick 13 — two bugs in the generator, one of them silent

**The scan was looking at the wrong half of the build tree.** It walked the
Zephyr build subdirectory, and an application's own objects live outside it.
Every `K_THREAD_DEFINE` and most `SYS_INIT` entries in a sample are in exactly
those objects, so they were invisible: the generator saw 99 objects and missed
the one that mattered. It now walks the whole build tree and sees 100.

**A weak fallback for a section that exists is worse than no fallback.** The
fallbacks were emitted for any family the generator did not find members for,
which included families it simply could not see. That is not harmless: giving
wasm-ld a definition suppresses the bounds it would otherwise synthesise, so a
list that really does have members reads as empty. The generator now
distinguishes a section that is referenced from one that is defined, and
emits a fallback only for families that are referenced and defined nowhere.

That rule alone was not enough either, because the kernel's own init lists are
pay-per-use: their entries sit in objects the link may never pull in, so a
section can be defined in some object and still be absent from the image.
Those two families get an anchor member instead, which is unambiguous, keeps
the section present, and does nothing when called.

The general shape of this is worth keeping for the report: a build step that
reasons about sections from object files is reasoning about a superset of what
ends up in the image, and the difference is exactly the pay-per-use linkage
Zephyr relies on.


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
