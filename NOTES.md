# NOTES — running log

## Loop state
Tick: 13 done  |  Last commit: section scan covers the whole build  |  Blocker: none

Two real bugs in the section generator fixed, and the sample still stops after
one line. Correcting an earlier note: in `samples/synchronization`, `thread_b`
is the **static** thread (`K_THREAD_DEFINE`) and `thread_a` is created from
main with `k_thread_create`. The thread that runs is the dynamic one, so it is
static threads that never start.

Where that leaves it: the generator no longer emits a fallback for
`_static_thread_data`, so the real section's bounds are in use, and the list
should be populated. Yet `thread_b` still never runs.

Next:

1. Check whether `z_init_static_threads` sees anything: print
   `__static_thread_data_list_start` and `_end` at boot, or count the entries
   it walks. That separates "the list is empty" from "the list is fine and the
   threads are not being started".
2. If the list is empty, the renamed section is being dropped at link time.
   `STRUCT_SECTION_ITERABLE` marks entries RETAIN, which survives in the
   object; confirm it survives the link too.
3. If the list is fine, look at the delay path: static threads are started
   through a timeout, so this may be the same wake machinery rather than
   anything to do with sections.

### Tick 12 — the kernel's clamp is not "never"

The host had been reading the kernel's clamped timeout as "no alarm at all".
It is not. When the kernel has no near deadline it does not send a sentinel;
it clamps to a deadline roughly two days out. Treating that as "never" ended
runs early, because the kernel idles briefly between being woken and
programming its next real deadline, and in that window the host concluded
nothing could ever happen again.

The host now keeps a clamped deadline as a real one and simply flags it. Time
still advances to it, the kernel still gets its chance to reprogram, and
quiescence is decided by watching what the kernel does next: waking from a
clamped deadline and immediately asking for another, twice in a row, means
there is no work left. Waking from a real deadline is progress and resets the
count.

That distinction is the interesting part. Under virtual time the host is the
only thing that can decide a program has finished, and the guest's own
"nothing soon" is not the same statement as "nothing ever". Conflating them
ends runs early, which is harder to spot than a hang because the exit status
looks like success.

With this in place a full sleep-and-wake cycle works: the timer fires, the
timeout expires, and the sleeping thread is resumed.


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
