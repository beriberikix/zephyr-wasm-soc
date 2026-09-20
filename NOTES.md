# NOTES — running log

## Loop state
Tick: 27 done  |  Last commit: documentation  |  Blocker: none

**The brief is complete.** Milestones 0, 1, 2 and 3 are done apart from
twister, which builds for the board but cannot find its SoC; the cause and the
fix are recorded in tick 25 and in the final report.

`README.md` now covers the shell, preemption, `west build -t run` and the two
new tests, and every command in it has been run. The final report carries the
safepoint numbers, the shell, and twister's limitation as an upstreaming
obstacle.

If the loop continues, what is left is genuinely optional:

* Restructure the workspace so `zephyr-wasm` is a project in the manifest
  rather than the manifest repository, which would make twister work and is
  probably the right shape anyway.
* Run a wider slice of `tests/kernel` and record what fails.
* The stack-switching backend, which the brief puts out of scope but which
  `DESIGN.md` says would remove most of what is awkward here.


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


### Tick 27 — documentation, and one number that moved

Folding the Milestone 3 work into `README.md` and the final report, and
running every command in the README again.

One thing worth recording. The time slicing test printed spin counts one apart
across two runs, which looked like determinism breaking under preemption. It
was not: the two runs were different binaries, because the UART work had
landed in between. Within one binary the counts are reproducible, and
`check_determinism.sh` confirms it. The README no longer quotes exact counts
as if they were stable across builds, since what matters is that both threads
get a large and roughly equal share.

That is a small example of the habit this project rewarded throughout: when a
number looks wrong, find out what actually changed before explaining why.
