# NOTES — running log

## Loop state
Tick: 29 done  |  Last commit: second engine  |  Blocker: none

**The module runs unchanged on wasmtime**, and produces byte-identical output
to V8. `host/run_wasmtime.py` implements the same `zephyr_host` ABI and the
same Asyncify driver loop in about 200 lines, leaving out everything
interactive.

| | Node (V8) | wasmtime |
|---|---|---|
| hello_world | passes | passes |
| synchronization | passes | passes |
| ztest semaphore | 32 passed | 32 passed |
| ztest output | 143 lines | 143 lines, identical |

That is worth more than the determinism check alone. Two runs on one engine
show the host is not leaking wall-clock time into the guest; two engines
agreeing shows the guest is not leaking engine behaviour into its results
either. Virtual time is doing what it was built to do.

One real difference between the engines turned up: JavaScript ignores a
surplus argument to an exported function, and wasmtime rejects it. The Node
harness had been calling `z_wasm_boot` with an argument it does not take, and
only the stricter engine noticed.

Browsers are still untested and still out of scope. The obstacle there is not
the module, which is now demonstrably engine-neutral, but the driver loop:
it runs synchronously until the guest suspends, which would freeze a page.


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


### Tick 29 — a second engine

Writing a wasmtime host took about 200 lines and an hour of nothing going
wrong, which is the interesting part. The module needed no change at all.

Both engines produce byte-identical output on the 143 lines of ztest. That is
a stronger claim than the determinism script makes on its own: two runs on one
engine show the host is not leaking wall-clock time into the guest, while two
engines agreeing shows the guest is not leaking engine behaviour into its
results. It is the clearest evidence so far that virtual time works.

The one genuine difference found: JavaScript ignores a surplus argument to an
exported function and wasmtime rejects it. The Node harness had been passing
an argument to `z_wasm_boot`, which takes none, and had been getting away with
it. A stricter engine is a better test.

What this does not show is anything about browsers. The module would run
there, but the harness would not: the driver loop is synchronous and blocks
until the guest suspends, which on a page's main thread freezes the tab. That
is a harness rewrite around a Worker, not a kernel change.
