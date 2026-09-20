# NOTES — running log

## Loop state
Tick: 25 done  |  Last commit: run target and twister schema  |  Blocker: none

`west build -t run` works and runs the module under the host harness, which is
the same target twister drives. The twister schema now knows about `wasm`.

Twister itself gets as far as finding the board and then stops:

    ERROR - SoC 'node' is not found, please ensure that the SoC exists and
            that soc-root containing 'node' has been correctly defined.

The cause is specific. Twister has a `--board-root` option but no
`--soc-root` or `--arch-root`; those come from module discovery, and
`zephyr_module.parse_modules()` returns an empty list in this workspace. The
module is not found because it *is* the manifest repository, so it is not one
of the projects west lists.

Two ways forward, neither attempted:

1. Restructure the workspace so `zephyr-wasm` is a project in the manifest
   rather than the manifest repository itself. This is probably right anyway
   and would need only a change to `west.yml` and the setup instructions.
2. Or have twister accept `--soc-root` and `--arch-root`, matching what
   `west build` already accepts. That is the better fix for anyone in this
   position, and small.

Also of note: twister needs Python packages the west environment does not
have. Seven of them, found one at a time: natsort, jsonschema, junitparser,
pytest, psutil and two more. A separate virtualenv was used rather than
changing the user's west installation.

Remaining Milestone 3 item: **UART and shell**. The shell needs input, which
the host harness has never had to provide, so it means extending the
`zephyr_host` ABI with a way to read characters.


### Tick 24 — preemption, and what it costs

Nothing preempts a running wasm function, so preemption has to be built rather
than configured. Two pieces.

**Safepoints.** A post-link pass inserts a call at the top of every loop body,
which covers the back-edge and the first iteration alike. The pass works on
the text format, where every loop starts on its own line, so inserting a call
with no operands and no results is a one-line edit per loop. It runs before
Asyncify, so the transform sees those calls and can suspend through them:
taking an interrupt there may switch threads. The dispatcher is skipped, since
instrumenting its loop would let a safepoint call it from inside itself.

**A counted tick, which turned out to be necessary rather than optional.**
The brief lists instruction-count time as a separate stretch item; it is not
separable. Under virtual time the clock only moves when the kernel idles, so a
thread that spins without calling the kernel freezes time, and a frozen clock
means the timer never fires and preemption can never happen. Safepoints alone
deadlock. Every `CONFIG_WASM_SAFEPOINTS_PER_TICK` safepoints the guest calls a
host import, and the host advances virtual time and raises any deadline that
has passed. That is what makes the spinning case work at all.

**The cost, measured on 800 million iterations of a tight arithmetic loop:**

| | Without | With | Ratio |
|---|---|---|---|
| Code size | 329686 | 337175 | 1.023x |
| Wall time | 1.74 s | 3.83 s | 2.28x |

The size cost is small. The time cost is large, and that figure is the worst
case by construction: the loop body is two arithmetic operations, so the check
roughly doubles the work per iteration. Real code does more between
back-edges, and the acceptance suite shows no perceptible change. Still, 2.28x
on tight loops is the honest headline, and it is the price of preemption on a
target with no interrupts.

The knob is `CONFIG_WASM_SAFEPOINTS_PER_TICK`: lower is more responsive and
slower. It decides how coarse preemption is for code that never calls into the
kernel.


### Tick 25 — a run target, and how far twister gets

`west build -t run` works. Getting there needed one trick worth recording:
Zephyr chooses an emulator by looking for `cmake/emu/<name>.cmake` inside its
own tree, with no hook for a module. Naming a platform in `board.cmake` stops
Zephyr defining its own `run` target that only prints "not supported", and its
own `if(EXISTS ...)` then finds nothing, which leaves the name free for the
module to define. The target itself cannot live in `board.cmake`, which runs
before Zephyr's directory has been added, so it sits beside the post-link
steps.

Twister gets as far as the board and stops at the SoC. The reason is worth
more than the symptom: twister takes a `--board-root` but no `--soc-root` or
`--arch-root`, relying on module discovery for those, and discovery finds
nothing here because this module *is* the manifest repository rather than a
project inside it. Restructuring the workspace would fix it, and so would
teaching twister the two options `west build` already has.

The other obstacle is duller but real: twister needs seven Python packages the
west environment does not carry, discovered one at a time because each import
fails separately. A separate virtualenv was the right answer rather than
changing the user's west installation.
