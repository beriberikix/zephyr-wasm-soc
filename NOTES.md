# NOTES — running log

## Loop state
Tick: 8 done  |  Last commit: generic swap-to-main  |  Blocker: none

Boot now reaches two switches: to the main thread, then to the idle thread.
It then loops in idle forever.

Trace, with `--trace-switches`:

    [enter] z_wasm_boot(0x0) sp=0x4000
    *** Booting Zephyr OS build e201b84b04e4 ***
    [switch #1] -> buf=0xa100 sp=0xa100 fresh
    [enter] z_wasm_thread_entry(0xd300) sp=0xa100
    *** Booting Zephyr OS build e201b84b04e4 ***
    [switch #2] -> buf=0xc100 sp=0xc100 fresh
    [enter] z_wasm_thread_entry(0xd270) sp=0xc100
    [enter] z_wasm_thread_entry(0xd270) sp=0xc100   <- idle, round and round

Three things to chase, in this order:

1. **Idle never wakes.** The host advances virtual time and sets the pending
   bit, but nothing runs. Check in order: is IRQ line 0 enabled by the time
   idle first suspends; is `z_wasm_irq_masked` zero when the dispatcher runs;
   does the timer ISR actually call `sys_clock_announce`. A trace of the
   pending word and the mask across a suspension will say which.
2. **The banner still prints twice**, once inside `z_wasm_boot` and once
   inside the main thread. Removing the custom swap-to-main did not change
   that, so the cause is elsewhere. Find where the banner is actually printed
   in this Zephyr version before theorising further; it is not in
   `kernel/init.c`.
3. **`arch_cpu_irqs_are_enabled` is declared but never defined**, which shows
   up as a warning. Implement it.

Also worth fixing in the harness: `--max-time` is checked between
suspensions, so a guest that never suspends is never interrupted. The wall
clock guard added this tick has the same flaw. Bounding a spinning guest needs
the safepoint instrumentation from Milestone 3, or an external timeout.

### Tick 7 — two real bugs, and how wasm reports them

**An empty init level was being walked.** The generator rounded every level's
array up to one element, so a level with no entries left a zeroed entry inside
the range `z_sys_init_run_level` walks, and the kernel called a null function
pointer. On hardware that faults at a null address. In wasm a null function
pointer is table slot 0, so the call is an indirect call with the wrong type
and the engine reports `function signature mismatch`, which points at the
callee rather than at the null. Empty levels are now genuinely zero-length, so
a level's start coincides with the next level's.

This is worth keeping as a portability note. Wasm checks indirect call
signatures exactly, where other targets tolerate a cast, so a class of
mistakes that would be a wild jump elsewhere surfaces here as a type error at
the call site.

**The Asyncify reservation was larger than the default stacks.** Every thread
stack object yields `ARCH_THREAD_STACK_RESERVED` bytes to its Asyncify buffer,
and the default main stack is 1024 bytes against a 4096-byte reservation, so
the split ran off the bottom of the object. The board now sets stack sizes
that clear the reservation with room left over. This is a real cost of the
approach and belongs in the final report: on this port every thread pays for
an Asyncify buffer whether or not it ever suspends deeply.


### Tick 8 — Asyncify cannot suspend in a function that never returns

This is the finding of the tick, and it is a real constraint rather than a
bug.

`arch_switch_to_main_thread` is declared `FUNC_NORETURN`, and this port
implemented it by filling the switch block and calling the host's `switch_to`
import. That cannot work. Asyncify instruments a call site so control can
resume there later, and there is no "later" past a call the compiler has been
told never comes back: the caller's chain is not instrumented, so the unwind
returns through frames that then carry on executing.

The fix was to stop selecting `CONFIG_ARCH_HAS_CUSTOM_SWAP_TO_MAIN` and let
the kernel's generic path reach the main thread through `arch_switch()` from
the dummy thread, which is an ordinary returning function. That works, and it
is also less arch code.

The general rule this implies is worth carrying into the final report: on this
port a suspension point can only appear in a function that can return. Any
Zephyr API declared noreturn cannot contain one.

A second, smaller lesson: the host's `--max-time` is checked between
suspensions, so a guest that spins without suspending is never interrupted.
Bounding that needs the safepoint instrumentation from Milestone 3. Until
then, a hang has to be killed from outside.
