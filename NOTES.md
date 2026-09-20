# NOTES — running log

## Loop state
Tick: 9 done  |  Last commit: hello_world  |  Blocker: none

**hello_world runs, and exits cleanly.**

    *** Booting Zephyr OS build e201b84b04e4 ***
    Hello World! wasm_node/node
    exit=0

That is the first of the four Milestone 2 acceptance criteria.

Next: `samples/synchronization`. It needs the parts hello_world never exercised
-- two threads alternating, `k_msleep` honoured, and the timer interrupt
actually delivered. The interrupt path has not yet been proven: nothing in
hello_world required a single interrupt to be taken. Expect the enabled-mask
question from tick 8 to resurface there.

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
