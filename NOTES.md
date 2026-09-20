# NOTES — running log

## Loop state
Tick: 28 done  |  Last commit: twister builds  |  Blocker: none

Twister now selects the board, resolves the SoC, uses the right toolchain and
**builds the test successfully**. It then fails inside twister itself:

    ERROR - General exception: Magic number does not match

That is twister parsing the built image as ELF to discover test cases. The
image is a wasm module, so there is no ELF magic to match. This is not
something the port can work around: it is twister assuming the artifact is
ELF, the same assumption that shows up in `gen_offset_header.py` and the
output steps, and it is recorded in the final report as such.

Everything before that point works, and the four things it took are worth
knowing for anyone trying this:

1. `ZEPHYR_EXTRA_MODULES` has to be in the **environment**, not passed with
   `-x`. Twister's module discovery reads the variable directly; the `-x`
   form only reaches CMake, by which point board discovery has already
   failed. This replaces tick 25's guess that the workspace needed
   restructuring: it did not.
2. `ZEPHYR_TOOLCHAIN_VARIANT` likewise, or twister filters the platform out
   for having no matching toolchain, silently and as a "static filter".
3. `west` has to be importable by the Python running twister, or CMake falls
   back to "Zephyr default modules (Zephyr base)" and finds no board.
4. The module needs its own `dts/bindings/vendor-prefixes.txt`. An
   undeclared prefix is only a warning in an ordinary build, and twister
   builds with warnings as errors.

The brief is complete. Everything beyond this point is new scope.


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


### Tick 28 — twister, as far as it goes

Tick 25 guessed that twister could not find the module because the module is
the manifest repository, and that restructuring the workspace would fix it.
That was wrong, and cheaply disproved: twister's module discovery reads
`ZEPHYR_EXTRA_MODULES` from the environment, and setting it there is the whole
fix. The `-x` form only reaches CMake, long after board discovery has failed.

With that, and the toolchain variant in the environment, and `west` importable
by the Python running twister, and a `vendor-prefixes.txt` in the module,
twister selects the board and builds the test.

Then it fails in twister, not in the build: `Magic number does not match`, from
parsing the built image as ELF to discover test cases. Nothing in the port can
answer that. It is the same assumption that runs through
`gen_offset_header.py` and the output steps, showing up one more time in the
place a new target meets the test runner.

Two of the four obstacles were only visible because the failure modes are
quiet. A platform whose toolchain does not match is reported as a "static
filter" with no reason given, and an undeclared vendor prefix is a warning
everywhere except under twister, where warnings are errors.

One more patch, the seventh, for a device API symbol the linker script
produces by grouping a class's section with those of classes extending it.
Grouping sections is exactly what wasm-ld cannot do, so the port uses the end
of the class's own section, which is exact only while nothing extends the
class. Recorded as a limitation rather than presented as equivalent.
