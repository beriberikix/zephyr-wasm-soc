# NOTES — running log

## Loop state
Tick: 12 done  |  Last commit: clamp handling  |  Blocker: none

Waking now works. The trace shows a full sleep-and-wake cycle:

    [switch #3] -> buf=0xc9e0 fresh        (idle)
    [idle] alarm=600100000 now=100000000 isr=1
    [switch #4] -> buf=0x49c0 resume       (thread_a wakes)
    [switch #5] -> buf=0xc9e0 resume       (back to idle)

So the timer fires, the timeout expires, and a sleeping thread is resumed.
That was the open question from tick 10 and it is answered.

What remains is narrower than it looked: **thread_b is never created.** Only
three contexts ever exist across the whole run, and they are main, thread_a
and idle. The sample creates thread_b with `k_thread_create` from main, so
either main never reaches that call or the created thread is never made
runnable.

Next:

1. Confirm by printing the thread count, or by watching for a fourth fresh
   context. `CONFIG_THREAD_NAME` would make the trace self-explanatory and is
   worth turning on while debugging.
2. If main never reaches the call, find out what it blocks on first.
3. If the thread is created but never scheduled, suspect `arch_new_thread`:
   in particular whether `switch_handle` is published in a state the scheduler
   accepts, since that is the one part of the switch contract this port has
   never verified against what the kernel expects.

### Tick 11 — the timer is right, the host's stop condition is not

Instrumenting the timer driver answered the question from tick 10 and raised a
better one.

Everything in the driver is correct. The ISR fires on schedule, announces the
right number of ticks, and the kernel reprograms sensible deadlines: a 500 ms
sleep becomes a deadline 500 ms later, to the tick. With that instrumentation
compiled in, `thread_a` prints over and over, which means the kernel is
scheduling, sleeping and waking exactly as it should.

Take the instrumentation out and the sample stops after one line. A behaviour
that depends on printing is a timing bug, and here the timing that changes is
the host's, not the guest's.

The suspicion falls on the host's stop condition rather than on anything in
the kernel. The host ends the run when the kernel idles with no alarm armed,
on the reasoning that nothing can ever happen again. That is true only if the
kernel has already had the chance to program its next deadline. The host
consumes the alarm when it fires, so there is a window where the kernel has
been woken, has not yet reprogrammed, and idles: the host sees no alarm and
declares the run over. Printing from the ISR widens the window enough to hide
it.

Worth stating as a general point about virtual time: the host decides when
time passes, so the host also decides what "nothing left to do" means, and
getting that wrong ends a run early rather than hanging it. A hang would have
been easier to notice.


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
