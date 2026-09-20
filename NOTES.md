# NOTES — running log

## Loop state
Tick: 11 done  |  Last commit: timer path verified  |  Blocker: none

The timer path is proven correct with real numbers. Instrumenting the ISR and
`sys_clock_set_timeout` shows the whole chain working:

    [set_timeout] ticks=5001 -> deadline=500100000
    [isr] now=100000000 last=0 ticks=1000
    [set_timeout] ticks=5001 -> deadline=600100000
    [isr] now=600100000 last=100000000 ticks=5001

Deadlines are right, ticks announced are right, and with that instrumentation
in place `thread_a` prints repeatedly instead of once.

**Remove the instrumentation and the sample stops after one line.** That is a
timing-dependent failure, and the shape of it points somewhere specific.

The hypothesis to test first: `advanceToNextDeadline()` in the host consumes
the alarm, setting `alarmNs` back to null when it fires. If the kernel idles
again before it has reprogrammed a deadline, the host sees no alarm, concludes
nothing can ever happen, and ends the run. Printing from inside the ISR
changes that interleaving enough to hide it. Note also that the kernel does
sometimes pass the clamp value, roughly `INT32_MAX` ticks, meaning "nothing
soon", and the driver turns that into no alarm at all.

So the host is very likely ending the run while a timeout is still pending.
Concretely: stop treating "no alarm armed" as the end of the run on its own.
Require that the kernel has idled with no alarm *and* nothing pending *and*
that it has had a chance to reprogram since the last announce. A simple fix
is to only end the run after seeing that state twice in a row with no
intervening interrupt.

### Tick 10 — three fixes, and the sample still stops

Three things were wrong and are now right. None of them was the thing that
stops the sample, which is worth saying plainly.

**The interrupt lock was global, and it is per-thread state.** A thread that
blocks while holding it left every other thread, idle included, running with
interrupts masked, so the dispatcher could never run and nothing could ever
wake. The trace showed exactly that: `masked=1` during the first idle. The
switch now saves the mask into the outgoing thread and restores it from the
incoming one, and a new thread starts unmasked.

**`arch_cpu_irqs_are_enabled` was declared and never defined.** It had been
sitting as a warning since the arch was written.

**Interrupt dispatch was not a reschedule point.** On hardware, returning from
an interrupt is itself one. Here the dispatcher is an ordinary call, and
anything it makes ready is deferred because `arch_is_in_isr()` is true while
it runs, so idle went straight back to idling. `arch_cpu_idle` now gives the
scheduler the chance it would otherwise have had.

All three are real and all three are keepers. The sample still emits one line
and stops, so something else is holding the threads.


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
