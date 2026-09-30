# NOTES — running log

## Loop state
Published at <https://beriberikix.github.io/zephyr-wasm-soc/>, built by CI
from a bare Ubuntu runner. `ROADMAP.md` is the plan; the score is 46 upstream
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

### Tick 48 — a screen, a finger, and LVGL

Phase 4 in four ticks, on its own branch at the user's request so that
Phase 3 could merge first.

The display is the flash again. `wasm,host-display` keeps a framebuffer
array in linear memory, names it to the host once, and reports each
rectangle it writes. The host reads the pixels between steps: into a canvas
on the page, or into a PPM with `--screenshot`, which lets CI check what a
build drew as well as what it printed. It is RGB565, not native_sim's
ARGB8888: LVGL defaults to 16-bit colour, and native_sim only avoids the
mismatch because its samples ship a board .conf this board would not get.
`samples/drivers/display` drew upstream's picture on the first run,
identically on both engines.

Input is the GPIO bridge again. The host queues events and raises a line,
and the ISR drains them into `input_report()`, with the same events
native_sim's SDL touch produces. `input_dump` printed a scripted touch
exactly. `draw_touch_events` then drew garbage: it sizes its buffer from
the display's devicetree `pixel-format`, assumes ARGB8888 when there is
none, and ours had none. The node now states it and the driver asserts it.

In the browser check a click landed at y=77 instead of 180. The canvas
extended below the viewport, so the click fell outside it; the page itself
was right. The check scrolls the canvas into view before measuring.

LVGL needed nothing but the import. All seven `modules/lvgl/demos` entries
pass their upstream criterion. The widgets demo draws on the page, and a
real tap on its Analytics tab switches to the chart, which is the input path
end to end. Its frame is byte-identical on V8 and wasmtime.

Score 41: 38 swept, plus blinky, button and the touch sample, which upstream
only builds and the demo checks by hand, as it does the other two.

### Tick 49 — one name per button

Every build passed in Chromium, and the screenshots showed a page that
disagreed with itself. The button was "Button 0" in the devicetree, `sw0`
under it on the page, "push" on its face, which did not fit, and "press
Button 0" in the menu. Every interactive build was told to "click the
output area and type", including the button, the touch sample and LVGL.
The speed control appeared only after Run, moving the toolbar under the
pointer, and the help text named two paced builds when there were four. The
LEDs and Erase flash were shown for builds with neither.

Each build in `apps.json` now has a short `title`, a one-line `hint` the
page shows under the controls, and a `uses` list for the parts of the board
it has. `apps.py` refuses a build without a hint. `stage_site.sh` checks
`uses` and `display` against each build's `.config`: flash and display must
match both ways, gpio one way, because input drivers pull GPIO into builds
with nothing on the LED strip. Parts are named by their devicetree labels.
The controls follow the selection, not the Run button. `check_browser.mjs
--screenshots` saves each build's page to look at, since nothing checks what
a page looks like.

### Tick 50 — the terminal was never tested by typing

The user tried the shell and found no cursor, and a Backspace that did not
delete. The browser check had always passed. It typed through a hook
that posted bytes straight to the worker, and it pressed buttons the same
way. It then looked for substrings in everything that was printed. It never
pressed a key, never looked at the screen, and never used Backspace, the
arrows or Tab.

The page's terminal kept text and dropped every escape sequence. Its
comment said that was enough to read the output. That holds for printk and
nowhere else:
- The shell's line editor draws Backspace as cursor left, reprint the rest,
  clear to end of line. With the escapes dropped, the deleted character
  stayed on screen, while the shell had deleted it.
- The philosophers position six rows with cursor addressing. They scrolled
  instead.
- The shell's log backend erases the prompt before a log line and redraws
  it after. The prompt stayed glued to the front of every log line, in
  LVGL, hsm and the shell.
- There was no cursor, and the arrow keys were never sent.
- Ctrl+C ended the run in the worker, as `run.mjs` does in a real terminal
  that has no other way to stop. The page has a Stop button, so Ctrl+C now
  goes to the guest, where the shell abandons the line with it.

The page now uses xterm.js 6.0.0, vendored with its licence in
`host/web/vendor/`. `zephyrOutput()` still returns the printed text, so every
expectation means what it did. `zephyrScreen()` and `zephyrCursor()` return
what is shown.

`check_browser.mjs` now uses the keyboard and the mouse:
- the ci_stdin lines are typed, and ci_gpio presses are the mouse held on
  the button;
- the shell takes a typo and Backspace, the up arrow, an edit mid-line,
  Ctrl+C and Tab, and the screen has to match after each;
- the philosophers have to show six rows, one per philosopher;
- LED 0 has to be lit only while Button 0 is held;
- blinky has to speed up at 4×;
- a drag on the touch sample has to be followed;
- LVGL's Analytics tab has to respond to a click;
- no shell build may show a log line behind a prompt.

The first run of that caught two errors in the check itself. One expected
the wrong text after a mid-line edit. The other passed LVGL's prompt test
on an empty screen, because its log output takes three seconds to arrive
behind the first frames. That test now requires the text on screen before
judging it.

### Tick 51 — everything stopped at 100 seconds

The user had Claude in Chrome try every demo on the live site. Sixteen of
seventeen did what was asked. The shell froze once: the clock stopped at
100010 ms, and typing did nothing until Stop. That number was the clue.

Both hosts treated a deadline at or past `CLAMP_NS`, 100 s, as the kernel's
"nothing soon" clamp. But `set_alarm_ns` passes an absolute time, so after
100 s of guest time every alarm looked like a clamp. Three idle wakes later
the host judged the kernel quiescent:
- a non-interactive run ended with exit 0, as if it had finished; blinky at
  150 s printed 102 toggles, not 150;
- an interactive run stopped advancing time, so the shell's 10 ms RX poll
  never fired again and nothing typed was read.

No check ran anything that long. The comparison is now against the delay
from now, in both hosts, and CI runs blinky for 150 s on both engines and
counts 150 lines. Before the fix it counted 102.

Two things fell out of fixing it.
- The interactive builds now run paced, so a person sees real timestamps.
  That made the input driver's ISR, which drained every queued event in one
  interrupt, overflow the input queue on a drag: `K_NO_WAIT` drops what does
  not fit. It now takes one sample per interrupt, through the event with
  sync, and the host raises the line again while it has more, as a touch
  controller would.
- `report()` was throttled to one every 100 ms of wall time, so a run shorter
  than that was shown as it stood at its first switch. It reports once more
  at the end.

The rest of the report was the page:
- Stop said "exit code 0" and left LED 0 lit. It now says "Stopped.", and
  the board goes dark.
- The status said "Running." while paused.
- Resume and Step stayed live after a run, because a late state message
  turned them back on.
- The previous build's output stayed up after choosing another. Choosing
  another build now stops the run and clears it.
- Stop took seconds at quarter speed, because the pacing wait could not be
  interrupted. Now it can.
- Clear took the shell's prompt with it.
- Logging overflowed a 4,000-line scrollback. It is now 20,000 lines.

Explained rather than changed:
- The logger's negative throughput is upstream's `uint32` product
  overflowing: on a virtual clock logging takes no time.
- "Button 11" is the key code `INPUT_KEY_0`.
- The NVS hex line wraps mid-byte, as a 400-column line would on any serial
  console.

### Tick 52 — a full C library, and constructors that never ran

The roadmap put the C library first among the things in this port's hands:
20 sample entries were either filtered out for want of one or failed to
build without `string.h`. The question was whether picolibc, which Zephyr
builds from source as a module, builds for wasm32 at all.

It does, after five small things, all in `DESIGN.md` D11: a byte-order macro
clang does not define for wasm32; the C library on the link line; a malloc
arena that does not need a linker symbol; three 128-bit helpers there is no
compiler-rt to supply; and one picolibc patch for a `.fini_array` entry the
wasm backend refuses. `setjmp`, the predicted snag, never came up.

Then the samples. POSIX `env` and `uname` pass. POSIX `philosophers` built
and printed its banner and nothing else: `pthread_create()` was refusing
every thread, silently, because the sample only reports errors when asked.
Rebuilt with its error checking on, it said the stack was below
`PTHREAD_STACK_MIN`. That minimum is the 4 KB Asyncify reservation here, and
the default dynamic stack is 1 KB. With the arch defaulting the stack to the
reservation, it passes.

`cpp_synchronization` failed to link on `__zephyr_init_array_start`, which
turned out to mean more than one sample: wasm-ld collects constructors into
`__wasm_call_ctors()`, and nothing had ever called it. No constructor had
run on this port, in C or in C++. The kernel's list now has one entry that
calls it, and the sample gets as far as D8b.

The rest need something picolibc does not provide: a C++ standard library,
modules not imported, a return address wasm cannot give, per-arch assembly.
`logging/syst` was tried with its module imported, found to stop on
`__builtin_return_address`, and the import taken back out.

`%f` was on Phase 0's list of unknowns. It works: under the minimal libc
with `CBPRINTF_FP_SUPPORT`, and under picolibc's own `printf`, which needed
two of the three 128-bit helpers.

Score 41 to 44.

### Tick 53 — the D8b fixes, written for Zephyr

D8b was the largest single thing between samples that build and samples
that run: thread entries whose type is not `k_thread_entry_t`, which wasm
traps on and every other target lets pass. The fixes belong in Zephyr, not
here, so this tick wrote them as a series for Zephyr: `upstream/zephyr/`.

The first triage had found the sites by reading. This time the compiler
did it: clang's `-Wcast-function-type-strict` reports the cast inside
`K_THREAD_DEFINE()` that hides every one of them. It found two that reading
had missed: the zbus benchmark's consumer threads return `int` rather than
`void`, which traps just the same, and `msg_subscriber` has a second
one-argument entry. The second was missed a second time. The warning
listed it, and the first try still failed on it. The CMSIS-RTOS v1 wrapper
the warning cannot see at all, since it converts a `void *` rather than
casting; it was found by reading.

The warning also reports the minimal libc's `sprintf.c`, which passes a
function taking `struct emitter *` where one taking `void *` is expected.
In C that is the same undefined behaviour. Wasm does not trap on it:
its check compares value types, and every pointer is an `i32`. Left alone.

`scripts/try_upstream.sh` applies the series for one run and takes it out
again. With it, all 23 entries pass, so all ten applications, and
`tests/kernel/mutex/mutex_api` and `tests/kernel/pending` finish and pass.
The score would be 54. It stays 44: "unmodified" means Zephyr as it is.

Zephyr's contribution guidelines turned out to have a section on AI
assistance. An agent must not add `Signed-off-by`, and AI help is
disclosed with `Assisted-by: <agent>:<model version>`. The patches follow
both, and `upstream/README.md` says what the person sending them has to add.

### Tick 54 — sensors, and a board that can be tilted

Phase 5 started where the sweep pointed: eight samples filtered out only
for want of `accel0`, `pressure-sensor` or `stream0`, each a kind of part
upstream already emulates. So the board got upstream's emulated I2C
controller, with a bmi160 on it -- the accelerometer upstream's own LVGL
chart sample puts on native_sim -- and a bmp581. The drivers are the real
ones. `accel_polling` passed on the first build, reading zeros, which is
what an emulated chip nobody has set reads.

Zeros make a dull lesson, so the host now sets what the chips read.
Upstream's tests call `emul_sensor_backend_set_channel()`; a bridge makes
the same call from an interrupt, with readings the host queues. The page's
Tilt pad sends gravity, and the real driver reads it back over the bus,
quantised by the chip: 1.5 m/s² returns as 1.49999.

What did not work, and why, is the useful part:
- `accel_trig` and the two stream samples need an interrupt, and none of the
  sensor emulators upstream ships drives one. That is emulator work,
  and upstream's to have.
- The LVGL accelerometer chart runs and follows the tilt, but slower than
  real time: 3 s of guest time in about 10 s. A CPU profile, mapped back to a
  name through LVGL's own object files since the linked module has no name
  section, put 96% of the time in `lv_draw_sw_fill`. The chart redraws a full
  screen fifty times a second, and a pixel loop pays for a safepoint every
  iteration. The first case where "performance is a non-goal" costs
  something a learner would see.
- The host's wall-clock limit timed the whole run, so it gave up on the
  chart as a guest "that ran without suspending", which it was not. It now
  times what its message says: the time since the guest last suspended.

The full re-run of filtered entries turned up one stale record:
`smf_calculator` had been filtered for want of a display since before the
board had one. It builds now, and fails on `strtod`.

Score 44 to 46.

### Tick 55 — the IP stack works, once it can find its interfaces

Phase 6's first question was the cheapest one: does Zephyr's IP stack work
on this port at all? The sweep could not say. Every networking sample needs
a peer, and the two sweep entries that pulled the stack in failed to link on
`_net_if_list_start`.

That symbol is the port's fault, and a quiet kind of fault. Every ELF
linker script defines `_<family>_list_start` and `_end` for each iterable
section. The section macros never use those names, and on wasm patch 0004
points the macros at the port's own markers, so the generator only ever
defined those. `net_if.c` declares its bounds by hand under the classic
names; in all of Zephyr only it and USB's config data do. The generator now
defines both names, in the same sections.

Zephyr's own network test suites need no peer, so they were the way to
answer the question, the way `tests/kernel` answered it for the kernel.
`check_kernel.py` learned to run another tree (`--list`), and
`scripts/net_tests.json` records all 139. The first two tried were the
socket suites: UDP 36 of 36, TCP 65 of 65. Then the rest: 102 of 139 pass,
1,144 cases, with no network code touched.

The other 37 are mostly one thing: mbedTLS. Every one of the 17 suites
Kconfig refuses wants it or PSA crypto, IPv6 among them, because its
privacy extensions select PSA. So importing mbedTLS is the next lever, as
picolibc was for the C library. Four suites trap on an indirect call, which
looks like D8b's family again, and are recorded rather than chased.

A build bug came out of checking the fix. Neither the sections generator
nor the offsets generator was a dependency of its own build step. The site
checks after the list-bounds change therefore ran on the old bounds and
passed without testing anything; a grep for the new names in a site build
found none. Both scripts are dependencies now.

`posix/eventfd` now links, then prints nothing after the banner, and its
`main` is gone within six switches. Not diagnosed.


### Tick 56 — the first lesson, and what the table was missing

The roadmap had named the first lesson, the philosophers, and what it needed
first: the thread table said `pending` and not what a thread was pending on.
For this sample that is the whole lesson.

The guest now says, in three more fields of the record it already filled
(`DESIGN.md` D8e):
- the wait queue;
- the mutex's owner, when the queue is a mutex's;
- the time left on the thread's timeout.

A wait queue does not know what it belongs to, so the owner is an
inference. The guest reads the queue as a mutex and believes the owner only
if it is a thread holding the lock. That is honest about its limits and
good enough for a table.

The time left was the subtle part. The kernel's answer,
`z_timeout_remaining()`, walks the timeout list, and every loop in the image
has a safepoint. None could dispatch, since the kernel holds its lock
there, but each one counts towards the next progress report, and a report
moves virtual time. So asking would have changed the run being looked at.
The safepoint pass can only skip a function it can name by export, so the
link now exports this one and the build tells the pass to skip it. The
records also outgrew the inspect stack they borrow the top of: 24 of them at
12 words is more than the 1 KB it had.

The first run of the new column showed something no one had asked for.
Philosopher 0 starts at priority 3 and was running at -2, because
Philosopher 5 was waiting for its fork. That is priority inheritance, and
the lesson now points it out.

A lesson turned out to be small: a `lesson` list on the build's `apps.json`
entry, and a panel with Previous and Next. It has six steps: run, pause,
step, find a waiter and its holder, why Dijkstra's ordering cannot deadlock,
and step back. The browser check follows them with real clicks and requires
a "held by" row naming a thread in the same table. The Node check requires
the same of `run.mjs --threads`. Both pass, as do all 18 site builds and all
25 kernel suites, whose case counts are unchanged.

Nobody learning Zephyr has tried it. That is the next test, and the only
one that says whether it teaches.


### Tick 57 — mbedTLS, which needed almost nothing

The loopback spike left mbedTLS as the largest single reason network suites
did not run: 19 of 37. The question was the one picolibc answered: does the
module build and work on wasm32 at all?

It does, with two things from the port and nothing from Zephyr or mbedTLS.

The first was not wasm's fault. mbedTLS builds itself with `-Werror`, and
clang 21 added `-Wuninitialized-const-pointer`. It fires in `x509_crt.c` on a
time that is passed by pointer and only read when `MBEDTLS_HAVE_TIME_DATE`
is on. That option is off in Zephyr's default configuration, so the warning
is a false positive, and it would stop the build on any target with this
compiler. `cmake/modules_wasm.cmake` turns off that one warning for that one
library. The one-line fix, with a ChangeLog entry, is in
`upstream/mbedtls/`, and applies to mbedTLS's `development`.

The second was the port's. The TLS suite passed DTLS handshakes and then
trapped with a bare `unreachable`. The trap was in
`asyncify_stop_unwind()`: Binaryen does check the buffer, after the unwind,
and a handshake suspends from 4,160 bytes of frames, 64 more than the 4 KB
every stack reserves. The host has always had a clear message for exactly
this, but it looked only after `asyncify_stop_unwind()`, which trapped
first. The host now looks first, and a build with mbedTLS gets an 8 KB
buffer. So the old claim that an overflow is silent was half wrong: it is
caught, but only after the damage.

Results:
- `socket/tls`: 49 of 49 pass, 4 skipped;
- `tests/net`: 112 of 139, ten more than before, with IPv6, websockets and
  the TLS servers among them;
- the score: 46 to 50, from `drivers/crypto`, `psa/its`,
  `psa/persistent_key` and `subsys/uuid`.

Two suites that now build trap on an indirect call, the HTTP/3 server and
QUIC, which makes six in `tests/net`. That is enough to be worth one
diagnosis for all of them.


### Tick 58 — six "signature mismatches", and only three were

Six network suites trapped with `null function or function signature
mismatch`, and the record called D8b the first suspect. It was the right
suspect for half of them.

The first obstacle was that no trap could be named. A trap said
`wasm-function[116]`, and neither the module nor `zephyr.elf` had a name
section. DESIGN D9 said the link called wasm-ld directly so that names
would survive. It never did: the link goes through the clang driver, and
the driver runs `wasm-opt` over the linked module, which drops the names
and rewrites the code. Building with `--no-wasm-opt` kept them.

With names, `conn_mgr_conn` trapped in ztest's `test_cb`, calling a
test's function. That entry's pointer was right in the image and zero at
the trap. So something had written to it. A copy of the module run through
Binaryen's `--instrument-memory`, with a host that watched one address,
caught the store: a `k_work_submit_to_queue` frame spilling its argument
into the ztest list. The ztest thread's stack, 1 KB by default, sits just
above that list, and the test had run off the bottom of it.

No guard noticed, because there is none. There is no MPU, and wasm does not
trap on a store inside its own memory. So an overflow shows up wherever the
damage is next used, which here was a function pointer, which made it look
like D8b. The board now defaults the ztest stack to 4 KB; 2 KB was not
enough for one suite. That fixed three of the six, and three suites
recorded with other symptoms: two PTP suites and `virtual`, whose eight
failures were the same overflow.

The other three were D8b:
- QUIC's socket vtables fill `.close`, and `zvfs_close()` calls a socket's
  `.close2(obj, fd)`, so every QUIC close traps. HTTP/3 runs on QUIC.
- CAN sockets have the same bug, found by looking for the pattern.
- The LwM2M RD client test keeps its callbacks in a `void *(*)()`.

Neither kind is visible to `-Wcast-function-type-strict`: one is a function
put in the wrong member of a union, and the other is an unprototyped
pointer. They are patches 0007 to 0009 in `upstream/zephyr/`. With them,
QUIC passes 81 cases and the RD client 28. HTTP/3 gets as far as a slab
corruption, which larger network stacks do not change, and which is not
diagnosed.

`tests/net` goes from 112 to 118 of 139. The score does not move: the
samples sweep, re-run, is unchanged.

`CONFIG_STACK_SENTINEL` was the obvious tool for this, and it works here on
a healthy sample. In the HTTP/3 suite, though, it reported an overflow on a
thread whose test does almost nothing, which is not explained. Until it is,
it is not a tool to rely on.


### Tick 59 — two boards, one wire

The roadmap had it as the next network item: several instances on one
page, with a virtual L2 between them. Networking's samples need a peer, and
until now a board had nobody to talk to but itself.

The wire is a small Ethernet driver, `wasm,host-ethernet`. Each frame the
stack sends goes to the host, and the host hands it to the other board. On
the page that is another Worker. In Node, `run.mjs --peer` runs the second
board in the same process. Two choices shaped it:
- **The node is off by default.** A snippet turns it on, so none of the 139
  network suites gains an interface it never asked for.
- **The link is real-time.** Both boards follow the wall clock, and frames
  arrive when they arrive. A lockstep coordinator would make a pair as
  repeatable as one board, but it means taking the clock away from
  `run()`. DESIGN D8k records what that would take.

Three things went wrong on the way, and each was caught by something that
already existed:
- The driver's `get_capabilities` had an older signature. The compiler
  refused it; on wasm it would have trapped instead.
- The section generator lost `net_sock`'s log entry. `libsubsys__net.a`
  holds two members named `sockets.c.obj`, the socket library's and the
  network shell's, and `ar x` writes both to one path. The generator
  already kept archives apart for exactly this reason, but a collision
  inside one archive was new. It now reads the archive format itself, and
  the link check that caught the missing entry passes. The same collision
  was why `tests/net/pmtu`, which also builds the socket library and the
  shell, failed to build, recorded as not diagnosed. It now passes, which
  makes 119 of 139 network suites.
- `echo_server` trapped at its first thread: four `void f(void)` entries
  through `K_THREAD_DEFINE`, the D8b pattern again. `echo_service`, a
  single-threaded server that pairs with the client as shipped, took its
  place. Patch 0010 fixes `echo_server` upstream.

With `echo_client` and `echo_service` the pair works as shipped:
- TCP over IPv4 and IPv6, each at about 750 packets a second in Node and
  about 160 on the page, where each frame travels from one Worker through
  the page to the other;
- UDP at the client's own pace of one packet every 150 ms;
- `net ping 192.0.2.2` from the service's shell, with 1 ms replies after
  the first, which waited for ARP.

The MAC comes from the board's entropy source, because the samples set
`CONFIG_TEST_RANDOM_GENERATOR` and two boards would otherwise share an
address.

The score is 52. Like blinky, the echo samples have no criterion twister
can run, since `harness: net` wants a peer. So the demo's checks judge
them: the Node check wants 1,000 echoes each way on both IP versions, and
the browser check wants the same through the page, typed into and stopped
by a person.


### Tick 60 — seven more pairs, and what "unmodified" means for them

The echo pair worked because `echo_client` happens to be set up for a
Zephyr server. Nothing else in `samples/net` is. Every other client is set
up for a Linux host at `192.0.2.2`, and every server claims `.1` itself.
Put two of them on one link and both boards take the same address. IPv6
duplicate address detection then refuses one of them, and an IPv4 client
talks to itself. No upstream overlay, test entry or bsim test sets any of
them up to face each other.

So the measure had to say what a pair may change, and the user decided:
- unmodified source;
- build arguments limited to the link, addresses, ports, and switching
  off an IP version the other side does not speak;
- each entry says in words what it set.

`apps.py` enforces the list and refuses anything else. Both refusals were
tried: a buffer count on the HTTP client, and a CoAP entry with its
sentence removed. This is looser than twister's criterion, and ROADMAP's
"The measure" says so, with a count: six of the 61 depend on it.

What came of it:
- **Three more echo servers, as shipped.** 4,000 TCP echoes each way in
  10 s. `echo` serves one connection at a time, so only IPv6 gets through.
- **CoAP, three ways, against one server.** `coap_client` walks every
  method, a 2 KB blockwise GET and an observed counter. `coap_upload` and
  `coap_download` move 2 KB in 64-byte blocks. The server speaks only
  IPv6, so the upload and download clients have IPv4 off. Otherwise each
  of their IPv4 attempts waits out a minute and a half of CoAP
  retransmits first.
- **HTTP.** GET and POST, over both IP versions. The server listens on the
  client's built-in port, 8000.

Two samples send once and give up, so the host gained a way to plug a
client in two seconds after its server. It is `start_after_ms` on the
page and `--peer-delay` in `run.mjs`. Until then frames towards the
client are dropped.

Three things did not make it:
- `dns_resolve` with `mdns_responder`: the network shell wants
  `strcasecmp`, which the minimal libc lacks.
- `zperf`: it needs both boards typed into.
- `echo_server`: it needs patch 0010.

One thing is upstream's and harmless. The CoAP upload and download
samples cancel their client right after the last callback, and the
library reports `-ECANCELED` for the request that has just finished. So
each prints an error after "done".

A detour on the way: building the clients through `xargs` stripped the
quotes from string options, and Kconfig refused the malformed values.
`stage_site.sh` passes arguments by plain word splitting, which keeps
them, and so the check runs use that path.

### Tick 61 — a browser agent tries the site

A browser agent ran all 26 builds on the live site from a written test
plan. It watched for console errors from the page and its workers, found
none, and marked six builds partly right. Three read-only investigations
then sorted real bugs from mistakes in the plan.

- **The accelerometer's blank eight seconds.** The page levels the Tilt
  pad with a reading as the run starts, before the guest has booted. The
  interrupt bit landed on a line the sensor bridge had not enabled yet.
  The host treated any pending bit as work, so it never jumped to the next
  deadline. So bmi160's 59 ms of boot-time busy-waits moved forward one
  safepoint tick at a time, about 12 million Asyncify round trips. The fix
  has three parts:
  - the host holds a line back until it is enabled;
  - both hosts judge idleness on pending, enabled and unmasked lines;
  - the guest's idle does the same.

  The banner now arrives in under 0.1 s, against 11 s before. With a
  reading at 0 ms there are 10 idle suspensions, not 12 million. CI never
  saw it because its scripted reading came at 1.5 s. The check now also
  sends one at 0 ms.
- **Back left the output behind.** The kernel came back exactly, but the
  terminal did not, so a re-step printed the same lines twice. The host
  now counts output bytes in the snapshot. The page rewrites its terminal
  when a state reports fewer bytes than it has shown.
- **The timer set its alarm early.** It counted the kernel's ticks from
  the last announcement rather than from now, so a `k_busy_wait` before a
  sleep brought the alarm forward by the busy-wait's length. The kernel
  reprogrammed it, so nothing went wrong but the status line.
- **Upstream's, written up rather than worked around.**
  - The echo servers print an IPv6 client's address from a 32-byte buffer,
    so `inet_ntop` refuses and they print stack garbage. Patch 0011.
  - `http_client`'s POST paths are for net-tools' Python server, not
    `http_server`, so the POSTs get 404 and 405. The hint says so now.
- **Mistakes in the test plan.** It asked for `kernel threads`, which is
  `kernel thread list` in this Zephyr. It also expected the echo server to
  print "(Ethernet)" unprompted, where CI types `net iface` first.

The rest were page polish:
- "running" in the thread table;
- the speed and the last build kept across a reload;
- a terminal that follows `data-theme`;
- output-only builds wrapping at phone width;
- two guards against a stale worker.

Two things turned up while checking the fixes, neither caused by them:
- **The LVGL demo boots in one step.** It spends 8 to 13 s of wall time
  drawing its first screen before anything suspends, with the old build
  too. The guard against a guest that never suspends allowed three times
  the run's guest-time limit, 15 s for a five-second CI run, so load alone
  could trip it. The guard now allows at least a minute.
- **The echo pair's client could beat its server.** `echo_client` gives
  up on a refused connection, and in one browser run it connected 0.35 s
  in, before the server listened. It now powers on two seconds after its
  server, as the CoAP and HTTP clients already did.

### Tick 62 — typing into the second board, and zperf

Per-board input turned out to be almost nothing. A board's UART reads
from the host's input queue whether or not it is interactive, and
`--interactive` only decides whether stdin fills that queue. So
`run.mjs --peer-stdin <file>` pushes the file into the second board's
queue when the board is made, where the bytes wait for its shell. The
page's second terminal already sent keys to its own board, so the browser
check only had to type into it.

zperf is its own peer. The client is the same sample with its addresses
swapped, and nothing else set:
- the server's shell runs `zperf udp download` and `zperf tcp download`;
- the client's runs a two-second UDP upload at 50 kbit/s, then a TCP one.

UDP moved 52 packets with none lost or out of order. TCP reports tens of
megabits a second, which only says the stack's copying costs no guest
time.

The first run stopped the client with an Asyncify buffer overflow: 4,240
bytes of unwound frames against a 4,096-byte buffer. The upload suspends
from the shell thread, below the command handler, the shell and the
socket layer. The port already gives mbedTLS builds 8 KB for the same
reason (a TLS handshake needed 4,160), so zperf builds get the same.
That is a board default, not an argument to the sample, and it stays
within what a pair may set.

The score is 62.

### Tick 63 — Stop means stopped

The second browser run passed everything, including the zperf pair over
IPv4 and IPv6. It found one rough edge. Stop, then Run, within a second or
two could make the next boot take 4 to 15 s instead of about 150 ms.

The page never ended a Worker itself. It asked the Worker to stop and
waited for `done`. A Worker hears the request only when its driver loop
yields, which leaves several ways to keep a core busy:
- **A change of build.** This detached the old Workers without ending
  them, and enabled Run at once.
- **A long step.** LVGL's first screen is a single step of seconds.
- **A paced guest behind the wall clock.** It never waited, so it never
  yielded.
- **Pairs.**
  - The first board's `done` re-enabled Run while the second was still
    running.
  - The old peer's `done` could then stop the run just started.

Now Stop, a change of build and a new Run terminate both Workers
outright. The one exception is a build that keeps flash: it gets 500 ms to
hand over its last image first. A paced run also yields at least every
50 ms. Three browser checks cover it:
- Run straight after Stop;
- switching away from LVGL mid-boot;
- stopping a pair.

### Tick 64 — two boards, one clock

A pair used to be two run loops, each following the wall clock, with
frames arriving whenever the relay got to them. That worked, but no two
runs matched, so a pair's checks could only be thresholds.

Now `host/pair.mjs` keeps both boards on one timeline:
- **Power-on.** Each board's clock starts at zero when it powers on. The
  second board powers on `start_after_ms` into the first's run, in guest
  time.
- **Frames.** Each is stamped with its arrival: the send time plus 100 µs
  of wire. The receiver takes it when its clock gets there, as it takes a
  scripted button press.
- **Scheduling.** The board that is behind runs, as far as the other could
  still reach it.
- **The Host.** It gained `start()` and `runUntil(limit)` beside `run()`.
  A single board goes through exactly the same steps as before:
  determinism, the two engines and blinky's 150 toggles all still match.

The first version was repeatable but slow: every echo exchange took about
10 ms of guest time instead of 0.2 ms. The trace showed the server running
10 ms past the client's send. The running board's limit had been fixed
before it ran, from when the idle board expected to wake next, but the
frame the running board sent woke it sooner. Sending a frame now pulls the
sender's limit in to that frame's arrival plus the wire's latency.

After that, the echo pair did 32,000 exchanges in the guest time the
wall-clock link managed 10,000. Two runs were byte-identical on both
boards. `check_site` now runs every pair twice and requires that, and all
nine pairs, run twice, take about a minute. On the page both boards run
in one Worker, since two Workers could only meet by message and the site
can't use `SharedArrayBuffer`. The pair is paced there as one. zperf's
rates are now the same every run.

### Tick 65 — picolibc by default, and the mDNS pair

The mDNS pair, `dns_resolve` against `mdns_responder`, was left out of the
first pairs because the network shell calls `strcasecmp` and the minimal
libc has only `strncasecmp`. The pair rule allows addresses and ports,
not a libc, so the question was the board's, not the pair's.

The board forced the minimal libc from before picolibc could be built for
wasm, and kept it after. Every other board gets picolibc, Zephyr's
default, unless a build chooses otherwise, so the sweep had been
measuring a choice upstream does not make. The board now chooses no libc.
`upstream/zephyr/0012` adds `strcasecmp` to the minimal libc as well: with
it applied, `dns_resolve` builds under the minimal libc, and without it the
build stops in `subsys/net/lib/shell/dns.c`.

A change to every build means re-measuring every record:
- **Samples**, all 230 entries: nothing worse. Three that stopped on a
  function the minimal libc lacks now build. `smf_calculator` then needed
  `__extenddftf2`, the double to binary128 widening picolibc's `strtod`
  uses; it went into `builtins.c`, checked against the host compiler's
  own conversion on 20 million doubles, and the LVGL calculator runs.
  The twister count stays 47.
- **Kernel suites:** all 25 as recorded.
- **Network suites:** six more pass, 125 of 139. One old note said
  wireguard needed an `EKEYEXPIRED` that picolibc lacks; picolibc has it,
  and the minimal libc is what lacked it.
- **The site:** all 28 builds, twice for each pair, in Node and Chromium,
  and determinism, both engines and blinky as before. Small builds grew by
  16 to 21 KB (hello from 80 to 96 KB, the shell from 402 to 423 KB),
  which is picolibc's stdio; the echo builds already used picolibc and did
  not change, and LVGL's shrank a little.

The pair itself ran first time. The client resolves `zephyr.local` to
192.0.2.1 and 2001:db8::1, and its plain DNS queries, with no server to
answer, are cancelled after their timeout, which is what upstream prints
too. The score is 64.

### Tick 66 — a real network, through someone else's relay

The last open Phase 6 item. The first plan was a relay of our own: passt
behind a WebSocket server written here. Looking at what already exists
changed it:
- v86's networking notes: its `wsproxy` protocol is one Ethernet frame per
  WebSocket message, and a family of relays already speak it.
- beriberikix/zephyr-v86: RootlessRelay, which needs no root, under
  `native_sim` inside v86's Linux. Outbound only.
- kartben/zephyr-in-the-browser: the page itself is the LAN by default,
  with an opt-in Go bridge, both on `192.0.2.1` with gateway `.2`, because
  that is what upstream's samples ship with.
- Tunnels (wstunnel, frp, bore): streams and ports, not frames, so they
  would still need a stack, and wstunnel's client is not a browser
  WebSocket. Useful beside a relay, to publish a port.

So `host/uplink.mjs` speaks wsproxy, and Node 22 and a Worker both have
WebSocket built in, so nothing is written server-side or installed. The
only change to the run loop: an uplinked board idles like an interactive
one, and a frame that arrives while it waits raises `IRQ.ETH`.

`dhcpv4_client`, as shipped, got `10.0.2.15` from RootlessRelay on the
first run, and from its shell pinged the gateway and resolved
`zephyrproject.org`. It was recorded as waiting for a DHCP server; it had
one now. The score is 65.

Static-address samples did not work: RootlessRelay fixed its pool at
`10.0.2.x` whatever `GATEWAY_IP` said, and sent DNS addressed to the
gateway out to the network. Two small fixes, now
`upstream/rootlessrelay/0001`, and `sockets/http_get`, unmodified at
`192.0.2.1`, fetched `http://google.com` from Node. The relay's own tests
pass with the patch. The page gets those samples once the fix is taken.

Two argument parsers in the checks treated index 0 as an option's value
when the option was absent (`-1 + 1`); `check_browser` had always had
it, and only worked because its default site path is the one CI passes.

### Tick 67 — the host is the LAN

kartben's page plays the whole network for its boards: DHCP, DNS, HTTP. The
same here would put the samples that want a Linux host at `192.0.2.2` on the
public site, with no relay, and on the board's clock, so repeatable. Two ways
to get a TCP stack were weighed: write one, as kartben did (no licence, so
ideas only), or use lwIP from tcpip.js, which the user asked to evaluate. The
evaluation settled it. tcpip.js's JavaScript runs lwIP off a wall-clock
`setInterval`, but the wasm itself reads nothing from outside except one WASI
clock call. Answer that with the board's time, drive the exports
synchronously, and lwIP is deterministic without a rebuild. So only the 94 KB
wasm is vendored, with its licences; `host/lan.mjs` is about 340 lines of
glue, comments included, and the services another 280.

The LAN's timers are one more deadline for the board's idle loop, on a 50 ms
grid; frames go both ways with the wire's 100 µs; and every service answers
from the board's clock and constants. DNS answers every name with the LAN
itself, which saves inventing remote hosts. http_get, tftp_client,
sntp_client (pointed at its server) and dumb_http_server (which the LAN
dials) all worked on their first run and repeat byte for byte. Score 69.

`scripts/check_lan.mjs` then put a second lwIP against the first and found a
real bug: an echo of 4 MB came back 2,256 bytes short, but 3 MB and 5 MB
were fine. The trace showed one segment retransmitted for ever with a bad
checksum. tcpip.js's tap interface hands a sent frame over as its first
buffer's payload with the chain's total length, and lwIP chains a buffer
when a write joins a segment not yet sent. The first fix, writing only when
nothing was in flight, avoided the chains but ran into delayed ACKs and
crawled: 58 KB in 15 s. The one kept finds the chain from JavaScript. The
struct pbuf sits just before the payload of a buffer lwIP allocated; it is
checked against the frame's own pointer and length, then walked. Every size
now completes, the check fails without the fix, and the issue is written up
in `upstream/README.md` for tcpip.js.

### Tick 68 — a browser round on the network builds

A Claude in Chrome run on the live site (f42e1e5) tried the five builds on
the simulated network, a bad relay URL, and three older builds. Nothing
failed. What it found, and what each turned out to be:
- **"Stopped at the page's 0-minute limit."** A page bug: the limit was
  rounded to minutes, and the network builds stop at 10 s of guest time.
  Under a minute it is now said in seconds.
- **"The host's own network" meant nothing to a visitor.** The hints now
  say what it is where it is used: the page plays a Linux host at
  192.0.2.2 on a simulated network. So does the status line.
- **The DHCP hint led with the optional relay**, and its `net ping 10.0.2.2`
  read like a mistake. It now leads with the simulated network and the
  shell commands that work on it, says Uplink can stay empty, and says
  10.0.2.2 is the relay's gateway, not this one's.
- **The echo server's terminal stays still.** echo_service doesn't log per
  packet; the hint now says so, and that the client does the counting.
- **Upstream, left as they are:**
  - `net iface` prints `DHCPv4 state` twice: `subsys/net/lib/shell/iface.c`
    prints it inside the DHCP block and again after it. It is a one-line
    patch, not written this round.
  - `net_config` logs the last-added IPv6 address on every DAD success, so
    `IPv6 address` appears twice.
  - The boot banner and `net_config`'s lines come after the sample's own
    `printf` output, because printk and LOG go through the deferred log
    thread while `printf` goes straight to the UART. A board with the same
    configuration does the same.

### Tick 69 — network samples with no one to talk to

Some `harness: net` samples need an interface but no peer. The sweep leaves
all `harness: net` entries out, so these count by the demo's checks, like
the pairs. Four were tried:
- **`net_mgmt`** adds an IPv6 address, waits for duplicate address
  detection and removes it, in a loop, and prints each event from a
  management socket. It runs on the LAN, as it should: nobody answers.
- **`stats`** prints the stack's counters every 30 s. On the LAN the only
  bytes received are the LAN's gratuitous ARP: 42.
- **`virtual`** stacks tunnel interfaces on the Ethernet one. It reports its
  IPIP interface as `-1` on every board, because it looks for a device
  called `"IP_tunnel"` and the IPIP L2 now names its devices `"IP_TUNNEL0"`
  and up. An upstream bug in the sample, noted here.
- **`socketpair`** prints FAILURE: `pthread_attr_setstack: Invalid
  argument`. Its thread stacks are 1 KB, and `PTHREAD_STACK_MIN` is
  `K_KERNEL_STACK_LEN(0)`, which here is the 4 KB Asyncify buffer every
  stack reserves (DESIGN.md D8). The sample would need bigger stacks, so
  it is not added.

The three that run are built with the snippet and nothing else, since
their entries `depends_on: netif`. They are plugged into the LAN, so what
they see is a repeatable wire, and check_site runs each twice. Each
repeated byte for byte. `ipv4_autoconf` was left out: its entry allows only
`qemu_x86` and `native_sim`. Score 72.

### Tick 70 — more services on the LAN

The plan was a WebSocket echo, CoAP over TCP and an MQTT broker, for
`websocket_client`, `coap_client_tcp` and `mqtt_publisher`. MQTT was out
before it started: both MQTT publishers allow only named platforms, so
twister would never run them here. The other two got their services, and
neither sample counts yet, for reasons in Zephyr rather than the LAN:
- **`websocket_client`** failed its handshake on the board with "Cannot
  calculate sha1 (-134)". Upstream commit f331614 moved the websocket
  library to PSA and selected `PSA_WANT_ALG_SHA_256`, but the handshake
  hashes with SHA-1, so on every target nothing provides it. Upstream `main`
  selects `PSA_WANT_ALG_SHA_1` now. Built with that on, it connected and
  then failed on its eighth message: the echo answered line by line, as
  `websocketd ... cat` would, and Zephyr's lorem ipsum has line breaks in
  it. The client checks that the bytes it sent come back in one message,
  so the echo now answers message by message. After that, 60 round trips
  in 20 s passed, with the same output on both runs.
- **`coap_client_tcp`** stopped at "Timeout waiting for CSM exchange",
  although the LAN had sent its CSM. The client stamps a request with
  `k_uptime_get()`, and a stamp of 0 means "never sent". A board here
  connects 0.4 ms into its run, so its first request is stamped 0, counts
  as expired, and the receive thread goes back to sleep. The stamp is also
  set after the receive thread is woken. `upstream/zephyr/0013` fixes
  both, and with it the sample runs to "Sample complete". It ends with
  "Close failed: -1" because the LAN closes on Release, which is what RFC
  8323 says a peer normally does.

The LAN is right in both cases (`check_lan` covers each service), so the
services stay for when the pin moves.

Then what else the LAN could unlock, from the `harness: net` samples not
yet on the page:
- **`ftp_client`**: the LAN got an FTP server, passive mode only, which is
  all Zephyr's client uses. It sends the command, waits for 150, and only
  then opens the data connection. Typed into: connect, list, get, cd.
- **`prometheus`**: it serves `/metrics` on port 80 and prints nothing
  when asked, so dials now take a path, the LAN logs the status line it got
  back, and `lan_expect` checks it.
- **`promiscuous_mode`** failed with -ENOTSUP until the Ethernet driver
  claimed promiscuous mode. The driver never filtered, so the claim costs
  nothing. The LAN pings it. It logs every frame as "unknown address
  family", because it reads the IP header at the start of a packet cloned
  before L2, where the Ethernet header is. That is upstream behaviour on
  any Ethernet board, and noted in the hint.
- **`pkt_filter`**: one of its rules drops IPv4 from 192.0.2.2. The LAN
  pings it, and the board answers the ARP but not the pings, which
  `lan_expect` checks as "no reply".
- **`vlan`** failed with -ENOTSUP until the driver claimed VLANs, which it
  also carried untouched already.
- **`dumb_http_server_mt`** traps on an indirect call: two `void f(void)`
  thread entries, as echo_server had (0010). `upstream/zephyr/0014` fixes
  it, and it then serves its page to the LAN's dial.
- **`big_http_download`** downloads an Ubuntu kernel and checks its
  SHA-256. The LAN could answer only with the wrong bytes, so it is left
  for a real network.

Seeing what the LAN did mattered for three of these, so its log now shows
on the page as `[lan]` lines, each on a line of its own, as `run.mjs` puts
them on stderr. Score 77.

### Tick 71 — a browser round on the new network builds

A Claude-in-Chrome run on the live site (3db2586) went through the five
new builds, the older network builds and a short regression pass. 11 of 13
rows passed. What it found, and what each turned out to be:
- **FTP: `mkdir test` was gone after Stop then Run.** The hint said what
  you put there lasts until the page reloads, and that was wrong. Each run
  gets a new LAN, and so a new tree, which is also what keeps a run
  repeatable. The hint and D8m now say it lasts for the run.
- **The web server's line ended in `HTTP/1.0 200 OK`.** That is correct:
  the test plan expected 1.1, and dumb_http_server answers 1.0.
- **`[lan]` lines came before board lines with earlier timestamps.** The
  terminal is in guest-time order. The board's LOG lines are printed by its
  log thread after the time they carry, so the LAN's reply at 1.000,400
  prints before the board's "Recv" stamped 1.000,100. Unstamped, the LAN's
  lines could not be lined up with the board's, so each now carries the
  board-clock time it happened at, in Zephyr's format:
  `[lan 00:00:01.000,400] ping 192.0.2.1 seq 0: reply`. The checks match
  on the text after the stamp.
- **The packet filter's table** lists the rule naming 192.0.2.2 as `OK …
  ip src block[…]`. A blocklist test passes a packet whose sender is not
  listed (`npf_ip_src_addr_unmatch`), so 192.0.2.2 matches no rule and is
  dropped. The hint now says so.
- **FTP answered Zephyr's `OPTS UTF8 ON` with 502**, which looked like an
  error during connect. It now says 200, as real servers do. The greeting
  and `readme.txt` no longer mention lwIP, which a Zephyr reader need not
  know about.
- **"`*** gave up after 10000 ms of guest time ***`"** read like a failure
  for a build that never ends by itself. The sweep matches that wording
  in Node, so only the page rewords it: "stopped at the page's limit of
  10 s of guest time", as its status line says.
- **The Prometheus hint** now says the log shows the answer's status and
  size, not the metrics.
- **Left as they are:**
  - the IPv6 address logged twice, and `DHCPv4 state` shown twice
    (tick 68);
  - the static address printed before DHCP (the samples' `net_config`);
  - the web server's banner before the boot banner (deferred logging);
  - `net iface` being long on a board with three interfaces.
