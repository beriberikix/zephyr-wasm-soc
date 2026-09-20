# NOTES — running log

## Loop state
Tick: 10 done  |  Last commit: per-thread IRQ mask  |  Blocker: none

`samples/synchronization` gets one line out and then both threads block:

    *** Booting Zephyr OS build e201b84b04e4 ***
    thread_a: Hello World from cpu 0 on wasm_node!

What is now known to work: the timer interrupt is enabled and taken, the ISR
runs, and the alarm is reprogrammed with the right deadlines (100 ms, then
600.1 ms for a 500 ms sleep, so `sys_clock_announce` is advancing the tick
count correctly). Interrupts are unmasked during idle. What does not happen is
a thread becoming runnable again.

Next, in order:

1. **Find out which thread 0xdc60 is.** The trace shows three switches and
   then only that one context resuming. If it is idle, both sample threads are
   blocked; if it is thread_b, it is blocked on its first semaphore take. The
   host can print the thread name: `struct k_thread` has one under
   `CONFIG_THREAD_NAME`, which is worth turning on for debugging.
2. **Check whether the timeout actually expires.** Instrument
   `sys_clock_announce` against `_kernel.timeout_list` rather than inferring
   from alarms.
3. **Suspect the switch handle.** `z_wasm_switch` recovers the outgoing thread
   with `CONTAINER_OF(switched_from, struct k_thread, switch_handle)` and this
   has never been verified against the thread the kernel actually meant. If it
   is wrong, a thread can be marked ready and still never be switched to.

A caution for whoever picks this up: the `ticks=` figure in the idle trace is
not trustworthy. The host reads it at a fixed offset past the ISR counter and
the two are not reliably adjacent. The ISR counter itself agrees with
everything else and can be believed.

### Tick 9 — hello_world, and three bugs between here and it

Three separate faults stood between the banner and the greeting. Two were mine
and one is a property of the platform worth keeping.

**Zero-length arrays in a section may not be emitted at all.** The generated
per-level init arrays were sized to the number of entries, so an empty level
got a zero-length array. Clang need not emit such an object, which leaves the
level's symbol pointing at whatever the linker put there instead, and since
`z_sys_init_run_level` walks from one level's start to the next, one level's
range silently swallowed another level's entries. That is why the boot banner
printed twice: it ran at two levels. Every level now gets at least one entry,
a no-op where it would otherwise be empty, which costs one call and keeps
every address well defined.

Spike A's conclusion that adjacent definitions stay contiguous still holds. It
just does not extend to objects the compiler may decline to emit.

**The kernel clamps rather than passing the forever sentinel through.** Asked
for an unbounded timeout, it sends roughly `INT32_MAX` ticks, not
`K_TICKS_FOREVER`. The driver only recognised the sentinel, so it armed an
alarm about two days out in virtual time, the host obligingly jumped there,
and the run died on its time limit. The driver now treats a request at or near
the clamp as what it means.

**printk and printf are different hooks.** The console driver installed only
the printk hook, which is enough for the boot banner and silently discards
anything written through the C library. hello_world prints with `printf`. Both
hooks are now installed.

Also: the harness now treats a kernel that idles with no timer armed as a
clean end of run rather than an error. For a sample that has finished its
work, nothing can ever happen again, and that is success.


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
