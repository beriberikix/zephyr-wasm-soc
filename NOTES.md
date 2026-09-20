# NOTES — running log

## Loop state
Published at <https://beriberikix.github.io/zephyr-wasm-soc/>, built by CI
from a bare Ubuntu runner. `ROADMAP.md` is the plan; the score is 3 upstream
samples and `scripts/apps.py score` is what counts it.


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


### Tick 32 — a third machine, and an output bug that had been there all along

Building on a machine that was neither the laptop nor the CI runner turned up
three things, two of them mine and one of them real.

**The harness truncated its own output whenever that output was piped.**
`host/run.mjs` ended with `process.exit(code)`. Writes to stdout are
synchronous when it is a terminal or a file and asynchronous when it is a
pipe, and `process.exit()` discards whatever is still queued. So every run a
person watched, and every run redirected to a file, was complete; every run
inside a shell substitution or a checking script was cut off mid-line. The
ztest suite reported 19 of its 32 cases that way and looked for all the world
like a guest that had stopped early.

It survived this long because nothing checked a piped run against what it
should contain. CI greps a command substitution, which is a pipe, but it
greps for a string that appears early enough to have been written. The fix is
to set `process.exitCode` and let Node exit when the stream has drained.

That is the second bug in this port whose whole character was that the thing
which should have complained said nothing (the first was a section that read
as an empty list). It is worth noticing the pattern: both were found by
writing something that asserted a result rather than glancing at one.

**Zephyr needs Python 3.12.** `west build` calls `pathlib.relative_to(...,
walk_up=True)`, which is 3.12 and later. The runner has it and this machine
did not, and the failure names pathlib rather than the version.

**The build otherwise reproduced exactly**, on clang 21 from apt.llvm.org,
binaryen 108 and wabt 1.0.34 out of Ubuntu. 143 lines of ztest output, two
runs byte-identical, the same numbers as the README claims. A third machine
agreeing is worth more than the second one did.

One incidental finding: `west init -l` takes the manifest repository's actual
directory name and records it, so the repository does not have to be cloned
as `zephyr-wasm` for the workspace to work. The name in `west.yml` matters to
`west init -m`, which is not how anyone sets this up.


### Tick 33 — what the demo is, checked rather than asserted

The site had five builds, a page that listed them in hardcoded markup, and CI
that ran three of them through grep. The timeslice test was built on every
run and never executed, which is the one build with a self-checking PASS line
in it. The shell was staged and never exercised at all.

The list now lives in `scripts/apps.json`, once, with what each build is
supposed to print beside it. `scripts/stage_site.sh` builds what it names and
writes `_site/manifest.json`; the page fills its menu from that; and
`scripts/check_site.mjs` is what CI runs. Adding a sample is one entry in one
file, and the entry carries its own acceptance criterion, which is the only
way the score in `ROADMAP.md` stays honest.

`scripts/check_browser.mjs` runs the page itself in Chromium and reads the
output back through the page's own terminal, including typing `kernel
version` and `demo ping` into the shell through the keyboard path a person
would use. Checking the modules under Node exercises the guest and the driver
loop and nothing else: not the Worker, not the message plumbing, not the
manifest, not the terminal. All five builds pass there, so those now have
evidence rather than a claim.

It still says nothing about engine neutrality. Chromium is V8, the same
engine as Node; that claim rests on the wasmtime host and always did.

