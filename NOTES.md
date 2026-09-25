# NOTES — running log

## Loop state
Published at <https://beriberikix.github.io/zephyr-wasm-soc/>, built by CI
from a bare Ubuntu runner. `ROADMAP.md` is the plan; the score is 39 upstream
samples, from the sweep in `scripts/samples.json`, and `scripts/apps.py score`
is what counts it.


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


### Tick 34 — the rest of tests/kernel, which was the point

The kernel's evidence was one suite. It is now 25 suites and 441 passing
cases, recorded in `scripts/kernel_tests.json` and re-run by
`scripts/check_kernel.py`: 16 pass outright, 4 finish with failures, 5 do
not finish. That is a considerably better kernel than one suite suggested
and a considerably worse one than "the kernel works" would have implied,
which is exactly why it was worth running.

Four things came out of it.

**An application's section entries could go missing if its filename
collided.** The generator scans what is about to be linked by extracting
every archive in the build tree, into one directory. Member names collide --
a test's source is usually named after the thing it exercises, so
`tests/kernel/common` has a `bitarray.c` and so does Zephyr -- and one
overwrote the other. The loser's iterable-section entries vanished from the
scan, the family was then classified as referenced-but-never-defined, and
the weak zero-length fallback that earns its keep for genuinely absent
families suppressed wasm-ld's real bounds instead. The list read empty for
ever after.

What it looked like from the outside: a parameterised test suite ran once
with a null parameter rather than seven times with its values, printed
"divisor 0", and divided by it. One directory per archive; that suite went
from 7 passing and a trap to 77 passing.

**A guest that never suspends could hang the harness for ever.** Both hosts
bound a run by guest time and by wall clock, and both checks sat between
steps -- which a spinning guest never reaches the end of. The message about
a guest running without suspending could not be printed in the one case it
exists for. `tests/kernel/device` prints its whole verdict and then sits
there; it was still alive seven minutes later. The check now also runs from
`safepoint_tick`, which such a guest calls by construction, and stops it by
throwing out of the import.

**`DEVICE_API_IS()` really is wrong on an extended class.** Patch 0007 says
so in as many words and calls it a limitation rather than an equivalence.
`tests/kernel/device` fails exactly the four cases that test it. Predicted
and now demonstrated, which is a better place to argue from.

**And the one that is not ours to fix.** Wasm checks the signature at an
indirect call and traps on a mismatch, where every other target ignores the
extra arguments and carries on. A thread entry declared
`void thread_05(struct k_sem *, struct k_sem *)` and cast to
`k_thread_entry_t`, or declared `void task_low(void)` and handed to
`K_THREAD_DEFINE`, traps the moment the thread runs.
`tests/kernel/mutex/mutex_api` and `tests/kernel/pending` both die on their
first case for this reason; correcting the signatures makes all 11 of the
mutex suite pass.

That one is worth dwelling on, because it is the first hard bound found on
"runs unmodified" that has nothing to do with the section shim, and because
the fix belongs upstream rather than here: those casts are undefined
behaviour on every target, and wasm is only the first one to say so.


### Tick 35 — three more samples, none of which needed any work

The score is 6. `samples/philosophers`, `samples/subsys/logging/logger` and
`samples/basic/sys_heap` all run unmodified, and finding that out took
longer than making it work did, because none of it needed making.

Logging is the surprise. It was on the phase 0 list as a prerequisite, on
the reasoning that nearly every sample past `basic/` calls `LOG_INF` and
that it brings three more iterable families with it, which made it the first
real test of the section shim under code written with no thought for this
port. The shim simply handled it: deferred logging, hexdumps, instance-level
filtering, runtime level changes, all of it, and byte-identical across two
runs and two engines.

`philosophers` is the one the vision issue wants phase 2 to visualise, and
it has apparently been running this whole time. `basic/sys_heap` is the
first thing to exercise the heap successfully, which is worth putting next
to `mem_heap/k_heap_api` panicking: whatever is wrong there is not that the
heap does not work.

Two more were tried and are not counted. `basic/minimal` runs and prints
nothing by design; counting a sample with no observable behaviour would only
make the number mean less. `basic/hash_map` spins without ever suspending
and gets given up on, which is the first sample found that does not work for
a reason nobody has looked into.

The general lesson is that nobody had tried. The port was measured against
what it was built against, which is the same reason the kernel's evidence
was one suite.


### Tick 36 — a virtual board, mostly by not writing one

`basic/blinky` and `basic/button` run unmodified, with the LED drawn on the
page and a button to press. The score is 8.

Almost none of this is new code. `drivers/gpio/gpio_emul.c` is board agnostic
and already implements pin state, direction, pull, edge and level triggering
and the callback list, so the port needed a bridge rather than a driver:
about a hundred lines that report output changes to the host through an
ordinary GPIO callback, and push the host's input changes back in through
`gpio_emul_input_set_masked()` when the host raises the GPIO line. Everything
above the bottom of that is the code a learner would run on hardware.

Two things cost an hour between them, and both deserve writing down because
neither announced itself.

**`gpio_emul` rejects a pin mask wider than the port.** Asking for all 32
pins of an 8-pin port returns `-EINVAL` rather than ignoring the extra bits,
so the bridge asked, got an error, returned early, and reported nothing. The
LED toggled correctly the whole time; only the page stayed dark.

**`gpio_emul` initialises at `POST_KERNEL`, not `PRE_KERNEL`.** The bridge
was at `PRE_KERNEL_2` on the assumption that a GPIO controller would be up
before the kernel was, and `device_is_ready()` answered honestly that it was
not, and the bridge returned `-ENODEV`, and nothing said so: a `SYS_INIT` that
fails is not reported anywhere. The sample kept working, because blinky drives
the pin through the controller and never touches the bridge. It sits at
`POST_KERNEL` priority 50 now, between the ports at 40 and `gpio-leds` and
`gpio-keys` at 90.

The pattern by now is familiar enough to be worth stating: three of the four
bugs this week were things that worked well enough to look fine. What found
each of them was printing a value, not reading the code.

Interrupts needed a line number that is not the timer's, so there is now one
place the line numbers live, `include/zephyr/arch/wasm/wasm_irq_lines.h`,
shared by the guest, the devicetree and both hosts, and a `wasm,host-intc`
node so a driver can name its line in the devicetree rather than in C. A page
raises one through the Worker; the host records it and applies it at the top
of its loop rather than writing guest memory from a message handler, since a
message can arrive before the module is even instantiated.

Scripted pin events (`--gpio 1000:4=0`) turned out to matter more than
expected. A sample that waits for a button cannot be checked unattended
otherwise, and a press at a stated guest time keeps the run deterministic,
so `basic/button` is in CI like everything else rather than being something
a person has to try.

`basic/threads` was the third sample this phase was meant to unlock and it
does not run: it declares `void blink0(void)` and hands it to
`K_THREAD_DEFINE`. That is D8b, and correcting the three signatures locally
makes it run and toggle LEDs, so nothing else is in its way.

One more for the collection, and this one was caught by the browser check
rather than by anything under Node. `core.mjs` gained an import of the new
`irq_lines.mjs`, and `stage_site.sh` copies the page's files by name, so the
staged site had a `core.mjs` importing a file that was not there. A module
that fails to load takes the Worker with it and reports nothing at all: the
page sat with its menu filled in and its Run button doing nothing. Under
Node everything passed, because Node loads those files from the repository
rather than from `_site`. The staged layout is a thing only a browser sees.


### Tick 37 — making a second last a second

Blinky ran from the first build and was unwatchable: under virtual time the
host jumps straight to each deadline, so five seconds of blinking is over in
sixty milliseconds. Correct, and no use at all to the person the whole idea
is for.

The fix is smaller than it looked, and the shape of it is the interesting
part. The obvious way round is to decide in advance how long to let the
guest run, which means the host choosing the guest's clock, which is the end
of determinism. Waiting *afterwards* has neither problem: the guest runs to
its next deadline exactly as it always did, the clock is set to that
deadline and never to however long the host actually slept, and then the
host sits out the difference before letting anything else happen.

So the guest cannot tell. Same build, three ways:

| | wall time | output |
|---|---|---|
| virtual | 0.06 s | identical |
| `--paced` | 5.07 s | identical |
| `--paced --time-scale 10` | 0.56 s | identical |

Which also means slow motion is free, and that is most of what phase 2 wants
from a time control. In Chromium the LED now changes at 1029, 2053 and
3082 ms of wall clock, which is blinky doing what blinky says it does.

One thing needed guarding. The kernel clamps "nothing soon" to a deadline
about two days out, and reaching it is the normal quiet end of a run; pacing
that faithfully would be a hang rather than a feature. Anything longer than
five seconds of virtual time is taken at full speed.


### Tick 38 — entropy, and the second engine earning its keep again

One import, one driver, and the only decision worth recording: the default
generator is seeded and repeats exactly. A real entropy source would end the
byte-identical guarantee that CI checks on every push, so
`crypto.getRandomValues` is behind `--true-random` and the default is a
xorshift32 from a fixed seed. `tests/drivers/entropy/api` passes, and it is
in the demo now as standing evidence rather than something that was true
once.

Both hosts implement that generator separately, from the same seed, which
means a build that prints random numbers has to print the same ones under
Node and under wasmtime. It did not, the first time: the wasmtime host wrote
to `self.memory` where every other line in the file writes to `self.mem`, so
the import raised and the run died five lines in. The two-engine check said
so immediately. That is twice now that keeping the second host a genuinely
separate implementation has caught something that a shared one could not
have.


### Tick 39 — watching the scheduler, which is the point of the whole idea

The issue calls this the affordance no other Zephyr target has, and it is
right, and it turned out to cost very little. The host brokers every context
switch already; "stopped between two switches" is a state it is in thousands
of times a second. Pausing is a flag, and a step is letting exactly one
suspension through.

Verified in Chromium against `philosophers`: paused, the switch counter held
at 97 through a second and a half; one click of Step took it to 98. That is
a learner watching the scheduler pick the next thread, one click at a time.

The thread table was the part with a decision in it. The obvious way to show
the kernel's threads is to hand the host the generated struct offsets, and
that is exactly wrong: the offsets are generated per build precisely because
they are not stable, so a host that knew them would go quietly wrong the day
a struct moved rather than failing. `z_wasm_inspect_threads` walks the list
in the guest and fills a fixed record instead. The host learns one shape and
no offsets.

Under Node, `--threads` prints the same thing to stderr, and it reads well:

```
[threads] at 600 ms, 5 switches, pending 0x0, next deadline 620 ms
  * thread_a           prio   7  queued      sp 0x1df0
    thread_b           prio   7  pending     sp 0x9c0
    idle               prio  15  ready       sp 0xce70
[threads] at 700 ms, 7 switches, pending 0x1, next deadline 1100 ms
    thread_a           prio   7  pending     sp 0x1df0
    thread_b           prio   7  sleeping    sp 0x9c0
  * idle               prio  15  ready       sp 0xce70
```

One thing cost half an hour and was entirely self-inflicted.
`stage_site.sh` skipped any application whose module was already built,
which is a sensible optimisation right up to the moment the thing you
changed is the module rather than the application. The page was staged with
modules built before the exports existed, the browser was the only thing
that could see it, and what it saw was a table that never appeared. It
builds every time now: west and ninja do nothing when nothing changed, so
the whole staging costs two minutes, and correctness is worth more than
that.

Stepping backwards is the obvious next thing and is not a kernel problem at
all: the machine is one buffer plus a few globals, so a snapshot is a copy
and a restore is a write. What makes it fiddly is the host's own
bookkeeping, which is not in that buffer -- the context map, the alarm, the
clock.


### Tick 40 — a diagnosis that got as far as ruling something out

`tests/kernel/mem_heap/k_heap_api` was one of the three suites recorded as
not finishing for reasons nobody had looked into. It is now one of three
that does not finish for a reason described precisely, which is not the same
as fixed but is a great deal better than "panics".

It panics at `test_k_heap_alloc_size[sizes/0]` on
`ASSERTION FAIL [z_spin_lock_valid(l)]`: the heap's spinlock is still
recorded as held by this CPU when that case tries to take it. The case
itself allocates one byte from a 2048-byte heap and cannot block, so
whatever left the lock in that state happened in an earlier case.

The obvious suspect is the blocking path: `k_heap_alloc` with a timeout
hands its lock to `z_pend_curr`, which releases it across the switch and
re-acquires it on waking, and this port's switch is an Asyncify unwind that
returns from the host much later. A thirty-line reproducer of exactly that
-- allocate, allocate something too big with a timeout, allocate again --
runs perfectly. So that is ruled out, and the reproducer is not kept,
because a test that passes is not a reproducer.

Worth noting for whoever picks it up: only `CONFIG_SPIN_VALIDATE` notices,
and that is on whenever `CONFIG_ASSERT` is. Nothing is claimed about builds
without assertions; the ownership simply is not tracked there. And
`samples/basic/sys_heap` runs, so whatever this is, it is not that the heap
does not work.


### Tick 41 — backwards

The last thing on the phase 2 list, and the one the issue is most right
about: on hardware, stepping a kernel backwards is a research project; here
it is a memcpy. A module is about 128 KB of linear memory, so a snapshot is
a copy of that, and a restore is a write.

Three steps forward and three back, in Chromium, on the philosophers:

```
start    97 switches, 1850 ms, idle holding the CPU
forward 100 switches, 1950 ms, Philosopher 4 holding the CPU
back     97 switches, 1850 ms, idle holding the CPU
```

The clock goes backwards too, which is the part that would be hard
anywhere else.

What took the thought was not the memory. It was everything that is not in
it: the virtual clock, the alarm and whether it was a clamp, the quiescence
count, the switch counter, the entropy state, pending input, the GPIO
levels, and the map of which Asyncify buffer belongs to which context. All
of that lives in the host and has to be copied alongside -- and the context
map rebuilt rather than shared, because restoring must not hand back
objects the run has since gone on mutating. That last one would have been a
long afternoon if the check had only compared a counter, which is why it
compares the clock and the current thread as well.

Asyncify needed nothing. Its buffers are in linear memory, so they come
along, and a snapshot is only ever taken between steps where its state is
normal.


### Tick 42 — the harness catching something, including itself

The full sweep after phase 1 and 2: 24 of the 25 suites exactly as recorded,
which is the answer wanted. GPIO, entropy and the three thread-monitoring
options that `CONFIG_WASM_INSPECT` selects are now in every build, and none
of it moved a single case.

The twenty-fifth was `poll`, reported as no longer building:
`'zephyr/kobj-types-enum.h' file not found`. It builds perfectly on its own,
and it built perfectly on the next parallel run too. So it is a race in
Zephyr's generated-header dependency edges, exposed by this harness building
three applications at once, and not a regression at all.

The harness now builds one at a time by default. A regression harness that
reports failures it caused itself is worse than a slow one, and the
distinction matters more here than elsewhere: the whole value of
`kernel_tests.json` is that a line moving means something.


### Tick 43 — every sample that could run, tried

The score was 8 because nobody had tried the others. Now all have been.
Upstream declares its samples in `tests.yaml`: 650 applications, 1268
entries. Of those, 229 entries in 143 applications could plausibly run here;
the rest name only hardware platforms, need a feature the board lacks, or use
a harness that needs a peer. `scripts/check_samples.py` builds each one with
the entry's own arguments and judges it by twister's own rules, so the score
is upstream's opinion, not this port's.

29 applications pass. With blinky and button, which upstream only builds,
the score is 31.

Five things this tick got wrong on the way, all corrected:

- The first build classifier read the whole log, so a missing `CONFIG_`
  symbol came out as a devicetree failure because some devicetree line
  appeared earlier. It now classifies by the error line and only falls back
  to the log for Kconfig and missing modules.
- The first sweep rewrote `samples.json` inside the repository while it ran,
  so every push cancelled CI. `--record` now takes a path outside it.
- ccache did not make the sweep faster. Zephyr refuses anything below 4.12
  unless told otherwise and Ubuntu has 4.9, so it was never used; what got
  faster was builds that fail in the first second.
- Every `null function or function signature mismatch` trap was tagged
  `d8b`, and seven of them were not. V8 says the same thing for a null
  pointer as for a wrong signature. The zbus ones are null: `_zbus_init`
  expects each channel's observers to be contiguous, upstream's linker
  script sorts them by name to make it so, and patch 0004's shim does not.
  The automatic tag is now `indirect-call`, and the notes in the record say
  which ones are really D8b. Two applications are.
- `drivers/display` passing does not mean the display works. Its regex is
  the banner. It and two others are marked `boot-only`.

Blinky has no candidate entry at all: its harness is `led`, a fixture label
twister has no class for, so upstream never runs it. Button is `build_only`.
That is why the score is the union of the sweep and `apps.json`.

Two passing samples are worth watching and are now on the page:
`kernel/metairq_dispatch`, which prints per-thread dispatch latency and
finishes, deterministically and identically on both engines; and
`smf/hsm_psicc2`, a hierarchical state machine driven from a shell, so
someone can type events at it and watch the transitions.


### Tick 44 — the right fix for the wrong reason

Tick 43 recorded seven zbus applications as failing on iterable-section
order: `_zbus_init` expects a channel's observers to be contiguous, upstream's
linker scripts sort them to make it so, and the shim did not. That is true of
the code and was not why they failed.

The ordering got fixed first, and properly. Patch 0004 now keeps the sort key
in the section name. `gen_sections_wasm.py` links a file ahead of everything
that names every family's sections in key order, between start and stop
markers. wasm-ld makes output segments in the order it first meets their
names, so that file decides the layout. `check_sections_wasm.py` then reads
the link map and fails the build if any family is not one unbroken, ordered
run between its markers. A spike confirmed each assumption on LLVM 21 first:
- zero-length retained segments survive gc;
- output segments follow first-seen order;
- entries from later objects join the earlier segment;
- the markers align;
- linked in the wrong order, a list silently shrinks, which is what the check
  exists to catch.

Everything built, CI went green, and the zbus samples trapped exactly as
before. So one sample got a scratch copy with nothing changed but its thread
entry, `void subscriber_task(void)` made to take three pointers. It ran in
full under the new layout. Then under the old layout too. The only difference
between the two runs was the order of the observers list, which the new layout
gets right.

Every one of the seven declares a thread entry `void f(void)` or
`void f(void *)`. They are D8b, and the triage said otherwise because V8 gives
a null function pointer and a wrong signature the same message, and because
reading `_zbus_init` produced a plausible story that nobody tested. The
record now says D8b for all seventeen entries, with the function named. D8b
is nine applications, not two, and the upstream signature fixes are the
cheapest nine applications on the list.

The ordering fix stays. It makes zbus notify and list in upstream's order,
makes log ids and test order upstream's, retires the anchor list and the weak
fallbacks, and turns the quietest failure the shim had into a build error.

The kernel sweep under the new layout found one more thing it does:
`mem_heap/k_heap_api` passes, all 23 cases, where it used to panic on a heap
spinlock left held by an earlier case. ztest's suites and tests are iterable
sections, so they now run in upstream's order, and in that order whatever
left the lock held never runs first. The other 24 suites are exactly as
recorded. That makes 17 suites passing outright and 450 cases, and one fewer
mystery, though the case that left the lock held is still unidentified.


### Tick 45 — the samples that "gave up" mostly should never have run

Seven entries were recorded as running for ever without passing:
- `hash_map` with newlib;
- `flash_shell`;
- four sensor polling samples;
- `tracing.gpio`.

The obvious suspects were a busy loop the safepoints miss and a clock that
never moves. It was neither, for six of the seven.

`accel_polling` builds its sensor list from the aliases `accel0` to `accel9`.
This board has none, so the list is empty and `main` sleeps for ever, printing
nothing. That is what it would do on any board without an accelerometer, and
upstream knows it: the entry says `filter: dt_alias_exists("accel0")`, and
twister never runs it on such a board. The same goes for the others:
- `die-temp0` and `distance0`;
- a chosen flash controller;
- `TOOLCHAIN_HAS_NEWLIB`, which is `OFF` for this toolchain.

The sweep had never looked at `filter:`. It now evaluates each filter with
twister's own `expr_parser`, against the build's `.config`, CMake cache and
`edt.pickle`, exactly as twister does after CMake, and records a false filter
as `filtered`. Run over every candidate that has a filter, that removed 87 of
the 229 entries. What twister itself would run on this board is 142 entries in
89 applications. The score does not move, and the denominator is now honest.

Two entries moved the wrong way, correctly:
- `synchronization.cpu_mask` passed, but needs SMP with more than one CPU, so
  upstream would never run it here. The app still counts through its main
  entry.
- `firmware/scmi` built, but needs `CONFIG_ARM_SCMI`.

The seventh was real. `tracing.gpio` printed every line upstream wants except
the last, `sys_trace_.*_user.*`. Every other architecture calls:
- `sys_trace_isr_enter/exit` around interrupt handlers;
- `sys_trace_idle/idle_exit` around the CPU's sleep.

This one called neither, so tracing backends and CPU load never saw an
interrupt or an idle period. Both now happen, in the dispatcher and around the
host wait, and the entry passes.

One slip, caught in the output: re-running an entry kept its hand-written note
but replaced a hand-confirmed `d8b` with the automatic `indirect-call`, which
is only a guess. It no longer does.

### Tick 46 — flash, and a board that remembers

Upstream's flash simulator needed nothing from the port. Off the posix arch
it keeps the device as one static array, here in linear memory, so giving
the board a `zephyr,sim-flash` node with a storage partition was the whole
job. The EEPROM simulator was the same. Five storage samples passed on the
first build:
- settings on NVS;
- all three ZMS entries;
- `drivers/eeprom`;
- `flash_shell`, through its scripted shell session.

The size was the only decision. native_sim has 2 MB. Every step-back snapshot
copies linear memory, so that would have made each one sixteen times larger,
for storage the samples use 12 KB of. 256 KB, with a 64 KB storage partition.

`kvss/nvs` then failed to link on `sys_arch_reboot`, because it proves
persistence by rebooting itself and counting. Rebooting and persistence turned
out to be the same feature:
- A reboot keeps the flash and loses RAM.
- The flash is an array in linear memory.
- So a reboot is a new instance of the module with the old array copied into
  the new one.

`flash_wasm_host.c` tells the host where the array is, straight after the
driver erases it at boot, and the host fills it from an image if it has one.
The `reboot` import throws out of the guest. The instance is being discarded,
so there is no point unwinding it, and the host boots a new one.

The ROADMAP had framed persistence as a choice between a suspending import
and an image loaded before the run. It was the second, and the reason is
simple: the host can read and write linear memory whenever the guest is
paused, and the guest is paused most of the time. So:
- the page loads the build's image from IndexedDB before starting the worker;
- the worker sends a copy back when it changes;
- the page saves it without anyone waiting.

`kvss/nvs` now shows six boots and a reboot counter kept in flash. With
`--flash`, the next run finds what this one stored. V8 and wasmtime print the
same output and leave byte-identical images. On the page, the browser check
runs it, reloads, runs it again, and fails if the second run finds an empty
flash.

Score 37: 35 swept samples plus blinky and button.

### Tick 47 — file systems, and two bugs that were waiting for them

FatFs and littlefs are Zephyr modules. `west.yml` now imports exactly those
two from Zephyr's own manifest, so they move with the Zephyr pin, and a plain
`west update` fetches them here and in CI. `fs/fatfs_fstab` passed on its first
build: FAT on the RAM disk its own overlay declares.

`fs/ext2_fstab` needs no module, and it had been failing with an implicit
int at `ext2_ops.c:659`. The overlay, the binding and the generated macros
were all correct. Preprocessing showed the cause: `DT_INST_FOREACH_STATUS_OKAY`
itself was undefined, because `<zephyr/devicetree.h>` was never included.
Every in-tree architecture's `arch.h` includes it and Zephyr code leans on
that; this one did not. With the include, ext2 formats its RAM disk and
passes. Re-sweeping every build failure found nothing else it fixed, which
settles the guess that `DT_ON_BUS` and friends were the same problem: they
are not.

`fs/littlefs` linked and then failed in the safepoint pass: "z_wasm_safepoint
is not exported". It was exported. The sample sets `CONFIG_DEBUG=y`, the
build is `-O0`, and the module keeps its name section, so `wasm2wat` prints
`(func $z_wasm_safepoint` where the pass only understood `(func 20)`. Any
debug build of anything would have hit this. The pass now takes either
spelling, and its output for index-form modules is byte-identical to
before. littlefs then mounted the board's storage partition, formatted it
and kept a boot counter, which persists in the browser the way NVS does.

Score 39: fatfs and ext2 fstab samples. The format and littlefs samples are
build-only upstream.

The sweep harness also stopped decoding guest output strictly. The ext2
sample prints its UUID as raw bytes, and a checker that dies on 0xff says
nothing about the sample.
