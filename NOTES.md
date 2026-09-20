# NOTES — running log

## Loop state
Published at <https://beriberikix.github.io/zephyr-wasm-soc/>, built by CI
from a bare Ubuntu runner. See the tick 31 entry for what publishing turned
up.


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


### Tick 31 — publishing, and what a second machine found

The repo is public at <https://github.com/beriberikix/zephyr-wasm-soc> under
Apache-2.0, matching Zephyr, and CI builds everything from scratch on each
push and publishes the demo to Pages.

Putting the build on a machine that is not this laptop found three things in
three runs, which is the point of doing it:

**The offsets generator was missing a force-included header.** Zephyr pushes
two headers into every compile, and the generator only passed one. The missing
one supplies the `__UINT32_C` family, which clang 23 defines itself and clang
18 does not. Correct all along on this machine, broken anywhere older.

**The safepoint pass loses the module's feature list.** Going through the text
format drops the `target_features` section, so the tools downstream fall back
to their own defaults. Newer Binaryen enables enough to hide it; the version
on the runner rejected `i32.extend8_s` outright. The features are now named
explicitly, which is more honest anyway about what the module needs. The first
attempt at a fix, wabt's `--enable-all`, was worse: it also turns on
wabt-only extensions that Binaryen then cannot parse.

**Ubuntu's clang is 18, and on 18 the linker leaves the iterable-section
bounds undefined.** Simple applications still built; ztest did not link. CI
now pins LLVM 21 from apt.llvm.org rather than quietly testing a toolchain the
README disclaims. What the true minimum version is remains open, and is worth
answering: the renaming half of the section scheme depends on a linker feature
whose history I have not pinned down.

That last one is the most interesting for anyone evaluating this. The section
approach rests on `__start_`/`__stop_` synthesis, and that support is newer
than I had assumed.
