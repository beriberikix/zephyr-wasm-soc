# NOTES — running log

## Loop state
Tick: 26 done  |  Last commit: UART and shell  |  Blocker: none

**The shell works.** Interactively, over a polled UART carried by two host
imports:

    uart:~$ help
    Available commands:
      demo, kernel, device, log, stats, history, ...
    uart:~$ kernel version
    Zephyr version 4.4.99
    uart:~$ demo ping
    pong

All four Milestone 2 criteria still pass and output is still deterministic.

Milestone 3 is complete apart from twister, which runs but cannot find the
module's SoC; tick 25 records why and what would fix it.

The brief is finished. What is left is polish rather than work:

* Fold the UART, the shell and `west build -t run` into `README.md`.
* Add the preemption numbers and the shell to the final report.
* `tests/safepoint_cost` and `tests/timeslice` are useful and undocumented.


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


### Tick 26 — UART, and input the host never had

The shell needed two things the port had never done: a UART, and a way for
characters to reach the guest.

**The UART is polled, and it has to be.** Nothing lets the host interrupt the
guest: the only mechanism is the pending word, and that is read at safepoints.
An interrupt-driven UART would have nothing to fire it. Polling costs nothing
here, because the shell thread blocks between characters anyway.

**Input needed the driver loop to stop being purely synchronous.** The host
reads stdin through Node's event loop, and that loop never got a turn, because
the Asyncify driver is a `while` loop that only stops when the guest does. It
now yields to the event loop whenever the guest idles, which is exactly when
input can matter and never on a hot path. Ctrl-C is handled in the host: raw
mode stops the terminal doing it, and the guest has no notion of a signal.

Routing the console through the UART also retired the bespoke console driver
in favour of Zephyr's own `uart_console`, which is one less thing that is
special about this port.

**One real bug fell out of it.** Turning the old console driver off left its
compiled object in the build directory, and the section generator scans the
build tree, so it emitted a reference to an init entry that was no longer in
the image and the link failed. The generator now scans the archives instead of
loose objects. Archives are rebuilt from the current source list, so they are
the honest view of what is about to be linked; a build directory is not.
