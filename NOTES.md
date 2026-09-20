# NOTES — running log

## Loop state
Tick: 18 done  |  Last commit: kernel stack reservation  |  Blocker: none

Both threads can now be started by hand and one runs. The trap that follows is
unchanged and is the single thing to chase:

    a: round 0
    RuntimeError: function signature mismatch
      at wasm-function[34]:0x5bba
      at wasm-function[21]:0x3fff
      at wasm-function[37]:0x7077
      at wasm-function[26]:0x4bd4      <- z_wasm_thread_entry
      at Host.step

Reading that chain: the host enters `z_wasm_thread_entry`, which calls
`z_thread_entry` (37), which calls the thread entry indirectly (21), which
calls the thread's loop (34), and the trap is inside that. It happens on the
host's attempt to resume the thread after its `k_msleep`, so it is a rewind
that goes wrong, not the original run.

Ruled out this tick, each by measurement rather than argument:

* **Stack or buffer too small.** Raising the thread stack to 8 KB and the
  Asyncify buffer to 16 KB changes nothing.
* **The host rewinding from the wrong buffer.** Instrumented; the buffer the
  guest names when unwinding always matches the one the host keys the context
  by, so no mismatch ever occurs.

Next, in order:

1. Confirm it really is a rewind: log in the host whether the failing entry
   was a fresh call or a `asyncify_start_rewind` before the call. One line.
2. If it is, dump the Asyncify buffer header before rewinding: the cursor
   should sit above the base and below the end. A cursor outside that range
   means the unwind wrote somewhere unexpected.
3. Build the module without `wasm-opt`'s default optimisation, using only
   `--asyncify`, and see whether the trap survives. That separates a genuine
   state problem from an interaction with Binaryen's other passes.

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
