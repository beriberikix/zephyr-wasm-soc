# NOTES — running log

## Loop state
Tick: 30 done  |  Last commit: browser  |  Blocker: none

**It runs in Chrome**, including the shell, typed into interactively.

| In the browser | Result |
|---|---|
| hello_world | banner and greeting, exit 0 |
| synchronization | threads alternating |
| ztest semaphore | 32 passed, execution successful |
| timeslice | both spinners ran, same counts as Node |
| shell | `kernel version` and `demo ping` answered |

No console errors. The ztest output is byte-identical to the Node run once
carriage returns are accounted for: the page's terminal consumes them, as a
terminal should.

This says nothing new about engine neutrality, because Chrome is V8, the same
engine Node uses. That claim still rests on wasmtime. What the browser adds is
that the harness is portable to somewhere with no filesystem, no stdio and no
blocking main thread.


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


### Tick 30 — in a browser

The obstacle was never the module, and that held: it needed no change at all.
It was the driver loop, which blocks its thread between suspensions and would
freeze a tab. The guest therefore runs in a Worker, with output and keystrokes
crossing by message.

Input needed no shared memory, which was the pleasant surprise. The driver
loop already yields to the event loop whenever the guest is idle, a trick
added for the Node shell, and a Worker's queued messages are delivered during
exactly that yield. So `postMessage` is enough and there is no need for
`SharedArrayBuffer`, and therefore none for cross-origin isolation headers.

Rather than write a third copy of the driver loop, the engine-neutral half now
lives in `host/core.mjs` behind a platform object of six hooks: load, write
out, write errors, clock, input, yield. `run.mjs` is the Node front-end and
`host/web/worker.js` the browser one. The wasmtime host stays a separate
implementation in Python on purpose, so that it remains an independent check
rather than the same code twice. The full Node acceptance suite was re-run
after the extraction and is unchanged.

The page carries a terminal just good enough to read the shell: it honours
carriage return, backspace and newline, and drops the rest of the ANSI. That
is also the only difference between the browser and Node output, and it is the
page being a terminal rather than the guest behaving differently.

What this does not show is a third engine. Chrome is V8. The browser tests the
environment, not the engine, and the write-up says so.
