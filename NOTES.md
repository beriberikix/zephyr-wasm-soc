# NOTES — running log

## Loop state
Tick: 19 done  |  Last commit: trap site identified  |  Blocker: none

**The trapping instruction is identified.** The failing function contains
exactly one indirect call, and it is this:

    local.get 1
    local.get 1
    i32.load offset=16
    call_indirect (type 0)          ;; type 0 = (func (param i32))

That loads a function pointer from offset 16 of a structure and calls it,
passing the structure itself. That shape is a timeout callback: Zephyr's
`struct _timeout` holds its handler at that offset and `sys_clock_announce`
walks the expired list calling `t->fn(t)`. So the kernel is announcing ticks,
finding the sleeping thread's timeout, and calling a handler pointer that is
not a valid function of that type.

The host trace confirms the setting. It is a rewind of the idle thread, its
Asyncify cursor is sane at 60 bytes into a 16 KB buffer, and the rewind
resumes inside `arch_cpu_idle` where the interrupt is dispatched and the tick
announced.

So this is memory corruption of a timeout structure, not an Asyncify problem.

Next:

1. Print the timeout's handler pointer and the thread it belongs to from the
   timer ISR before announcing. If it is zero, something cleared it; if it is
   a plausible but wrong address, something overwrote it.
2. Work out what shares that memory. The prime suspect remains the thread
   stack split, since a thread's Asyncify buffer sits immediately above its
   shadow stack and an overrun in either direction lands in the other, or in
   the next object. Print each thread's stack base, `stack_ptr`, buffer base
   and buffer end at creation and check for overlap directly rather than by
   reasoning.
3. `_timeout` structures live inside `struct k_thread`, so an overrun of a
   thread's own stack object into the adjacent thread struct would produce
   exactly this.

### Tick 18 — two hypotheses tested, both wrong, one real fix

Both of this tick's theories about the trap were wrong, and testing them cost
little. Enlarging the thread stack fourfold and the Asyncify buffer fourfold
changes nothing, so it is not a sizing problem. Instrumenting the host to
compare the buffer the guest names when unwinding against the one it keys the
context by shows they always agree, so it is not rewinding from the wrong
buffer.

One real fix came out of looking: kernel stacks had no Asyncify reservation.
`ARCH_THREAD_STACK_RESERVED` was defined and `ARCH_KERNEL_STACK_RESERVED` was
not, so the idle thread and the system work queue, which run on kernel stack
objects and suspend exactly like any other thread, were having their Asyncify
buffers written into whatever memory happened to follow. That is a genuine
corruption and it is now fixed, even though it was not causing this trap.

Reading the trap's call chain does narrow things usefully. The host enters the
thread trampoline, which reaches the thread's own loop, and the trap is inside
that, on the attempt to resume after a sleep. So the failure is in a rewind
rather than in the original run, which is a much smaller place to look.


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
