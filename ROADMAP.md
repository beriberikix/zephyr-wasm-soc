# ROADMAP — how much of Zephyr can run in a browser tab

[Issue #1](https://github.com/beriberikix/zephyr-wasm-soc/issues/1) sets out the
vision and the phases. This file is the working plan underneath it: the order
the work is actually done in, the things the issue did not account for, and the
decisions that only became visible once someone started costing the phases out.

Where this disagrees with the issue, this file is the newer document.

## The measure

**Upstream Zephyr samples that pass their own acceptance criterion.** Score
today: **31**, of which 28 check more than a start-up banner.

The number is computed, not claimed. `scripts/check_samples.py` reads every
`tests.yaml` under `zephyr/samples`, keeps the entries that could plausibly run
on a board with no hardware, builds each one exactly as twister would (with
the entry's own `extra_args` and `extra_configs`), runs it, and judges the
output by the entry's own `harness_config` using twister's rules: a console
regex, a ztest verdict, or a scripted shell session. An application counts once
if any of its entries passes. `scripts/samples.json` holds the result for every
entry, with a cause for every one that does not pass, and `scripts/apps.py score`
reads the score from there plus the curated demo in `scripts/apps.json`, which
adds `basic/blinky` and `basic/button`: upstream only builds those two, because
twister has no way to watch an LED or press a button.

What was tried, out of 650 upstream applications and 1268 entries:

| | entries | applications |
|---|---:|---:|
| Plausible on this board | 229 | 143 |
| Pass upstream's own criterion | 44 | 29 |
| Build, but upstream only builds them | 5 | |
| Run and fail their criterion | 6 | |
| Do not finish | 30 | |
| Do not build | 144 | |

The other 1039 entries were not tried, for reasons recorded in the summary of
`samples.json`: 655 name only hardware platforms, 112 depend on a feature this
board does not declare, and 267 use a harness that needs a peer or a person
(networking, Bluetooth, sensors, keyboards and so on).

Three passes are weak and are marked `boot-only` in the record, because
upstream's regex only checks that they started:
`code_relocation_nocopy` ("Hello World!"), `drivers/smbus` and
`drivers/display` (their banners). The display sample passing says nothing
about drawing anything.

Why the rest do not pass, the largest groups first (the long tail is in
`samples.json`):

| Cause | entries | what it is |
|---|---:|---|
| No such device | 36 | the sample wants a devicetree node this board has no driver for (`__device_dts_ord_N`) |
| Wasm's indirect-call check | 21 | 9 applications, 7 of them zbus; D8b, below |
| Missing module | 19 | LVGL (13 entries, counting its Kconfig), FatFs, TFLite, PSA |
| Kconfig refuses | 16 | options the board cannot satisfy, mostly hardware drivers |
| No C library headers | 16 | C++, POSIX, `syst` and the benchmarks need a libc with `string.h`; only the minimal one is here |
| Gave up | 8 | runs and never suspends: `hash_map` with newlib, four sensor samples, `flash_shell`, `tracing.gpio` |
| Needs a crypto driver | 7 | "You need to enable one crypto device" |
| Link | 7 | `__zephyr_init_array_start` (C++ constructors), `_net_if_list_start` (a section bound spelled by hand) |
| Fails its regex | 6 | codec, `uart async_api`, PM latency, settings on NVS, the two TF-M storage samples |
| Trap | 1 | `sensing/simple`, an out-of-bounds access |

**D8b is the largest thing between a sample that builds and one that runs.**
Wasm type-checks indirect calls, and before the sweep nobody knew what that
cost. It costs nine applications:
- `basic/threads`;
- seven zbus samples (`hello_world`, `benchmark`, `confirmed_channel`,
  `dyn_channel`, `msg_subscriber`, `runtime_obs_registration`, `work_queue`);
- `cmsis_rtos_v1/philosophers`.

In all but the last, a thread entry is declared `void f(void)` (or
`void f(void *)`) and handed to `K_THREAD_DEFINE`. In the last, the bug is not
in the sample at all but in Zephyr's `zephyr_thread_wrapper`, which calls a
`void (*)(void const *)` through a `void *(*)(void *)`.

Each is a one-line fix upstream, and each is undefined behaviour on every
target. Correcting zbus/hello_world's one signature makes it run in full here.
That makes the upstream signature fixes the most valuable next step for the
score: nine applications for about a dozen lines.

The zbus seven were first recorded as a section-ordering bug. V8 reports a
null function pointer and a wrong signature with the same message, and
`_zbus_init` does depend on the order of its sections, so the explanation fit.
It was wrong. With the signature corrected, zbus/hello_world runs under the
old section layout as well as the new one. The ordering was worth fixing
anyway (see "Iterable sections have an order", below), but it was not what
stopped these samples.

The sweep runs weekly in CI (`.github/workflows/samples.yml`), re-running
everything recorded as working and failing if any of it got worse. Dispatching
that workflow with `everything` re-runs all 229 entries, which is how an
improvement gets noticed.

The issue proposes the measure but nothing counts it. That is the first thing to
fix, because a number nobody computes drifts within a week:

* `scripts/stage_site.sh` writes `_site/manifest.json`, one entry per
  application, and the page builds its menu from it. Adding a sample is one
  line in one place instead of two that must agree.
* CI runs every manifest entry and asserts the output each one is supposed to
  produce. Today it greps three of the five builds by hand and never runs the
  timeslice test at all, which is the only build with a self-checking
  PASS/FAIL line in it.
* "Unmodified" is enforced by construction: a sample that needs a `prj.conf`
  edit or a source change is not counted. Devicetree overlays under
  `boards/` are allowed, because that is how every real board configures a
  sample, and a board overlay is not a change to the sample.

## Phase 0 — foundations

The issue starts at Phase 1. It lists "the kernel evidence is one test suite"
under risks and then never schedules it. Everything above the kernel stands on
the kernel, so this comes first.

- [x] **Run the rest of `tests/kernel`.** Done, and it was worth doing: 25
      suites and 441 passing cases, against one suite before. 16 pass
      outright, 4 finish with failures, 5 do not finish.
      `scripts/kernel_tests.json` records each one and
      `scripts/check_kernel.py` re-runs them, so it stays true.

      It found a section-shim bug that silently emptied an application's
      iterable lists, a missing timer symbol, and a harness that could hang
      for ever on a guest that never suspends -- all three fixed. It also
      found two things that are not bugs to fix:

      - Wasm type-checks indirect calls, so a thread entry that is not
        exactly `void (*)(void *, void *, void *)` traps. Every other target
        tolerates the cast. `DESIGN.md` D8b has the detail. This is a real
        bound on "runs unmodified", and the most upstreamable thing found
        here: the entries are UB on every target and cost nothing to correct.
      - `DEVICE_API_IS()` on an extended class is wrong, which patch 0007
        says it would be. Now demonstrated by `tests/kernel/device` rather
        than predicted.
- [ ] **The three suites that do not finish for unknown reasons**:
      `threads/thread_apis`, `sched/schedule_api` and `mem_heap/k_heap_api`,
      the last of which is also the only evidence about the heap.
- [ ] **Timer accuracy.** `common`, `timer/timer_api` and
      `tickless/tickless_concept` all fail on how long something took, which
      is one question wearing three hats: a slice ends at the next safepoint
      rather than on the tick.
- [x] **The manifest and the score**, as above. The score is now the
      samples sweep; see the measure.
- [ ] **Twister.** It builds for this board but cannot find the module's SoC,
      because it takes a `--board-root` and no `--soc-root` and relies on
      module discovery, which finds nothing when the module is the manifest
      repository. Until that is solved the scoreboard is a shell script.
      `boards/wasm/wasm_node/wasm_node.yaml` also has no `supported:` list, so
      twister would filter this board out of every `depends_on` test even once
      it can build them.
- [x] **Logging.** Already works. `CONFIG_LOG` was on this list because
      nearly every sample past `basic/` calls `LOG_INF` and because it brings
      three more iterable families with it, which made it the first real test
      of the section shim under something not written with this port in mind.
      The shim passed: `samples/subsys/logging/logger` runs unmodified and
      deterministically.
- [ ] **Make stack overflow loud.** The Asyncify buffer is not bounds-checked
      and a learner will overflow a stack on the first afternoon. Binaryen will
      not add a check, but the host can: the buffer's cursor and limit are two
      words it already reads for tracing, so comparing them at every suspension
      costs nothing and turns silent corruption into a reported fatal.
      `CONFIG_STACK_SENTINEL` covers the C shadow stack and should be on.
- [ ] **Build hygiene.** `scripts/instrument_safepoints.py` skips
      `z_wasm_switch` by name, but that function is not exported, so the skip
      matches nothing and a loop added there would be instrumented from inside
      the switch path. `scripts/gen_sections_wasm.py` carries an `ITERABLES`
      dict that looks like the registry of section families and is dead code.
      `llvm-ar` is an undeclared tool dependency. `tools.env` will silently
      select the LLVM 18 the README disclaims.
- [ ] **Documentation drift.** The README says five patches in one place and
      seven in another, says browsers are out of scope two paragraphs below the
      section on running in a browser, and points at a final report in
      `NOTES.md` that was deleted in `91afbd3`.

Unknowns that Phase 0 is expected to turn up, all of them untested today:
`k_malloc` and the heap, `%f` in `printk` (`CONFIG_CBPRINTF_FP_SUPPORT` is off
and the minimal libc is the only libc here), and `CONFIG_MULTITHREADING=n`,
which nothing in the port has ever considered.

## Phase 1 — a virtual board

Done. It was the largest unlock per unit of work and it turned out to be
mostly a bridge, because Zephyr already ships the hard part.

- [x] **GPIO**, as a bridge rather than a driver. `drivers/gpio/gpio_emul.c`
      is board agnostic and already implements pin state, direction, pull,
      edge and level triggering and the callback list, so
      `drivers/gpio/gpio_wasm_bridge.c` only carries it across: a callback on
      every pin reports output changes to the host, and the GPIO interrupt
      pushes the host's input changes in through
      `gpio_emul_input_set_masked()`. A learner therefore runs the same GPIO
      code every emulated Zephyr target runs.
- [x] **An interrupt line that is not the timer.**
      `include/zephyr/arch/wasm/wasm_irq_lines.h` is now the one place the
      line numbers live, shared by the guest, the devicetree and both hosts;
      a `wasm,host-intc` node lets a driver name its line in the devicetree
      the ordinary way; and a page can raise one through the Worker. The host
      records the line and applies it at the top of its loop rather than
      writing guest memory from a message handler, because a message can
      arrive before the module is even instantiated.
- [ ] **Entropy**, over one import. The catch is that
      `crypto.getRandomValues` would break the determinism check CI depends on,
      so the default has to be a seeded generator with true randomness as an
      opt-in, in the same shape as `--realtime`.
- [ ] **Real time.** Blinky sleeps a second between toggles; under virtual time
      it finishes instantly and blinks nothing. The host needs a paced mode
      that sleeps until the next deadline rather than jumping to it, and a time
      scale, which is also the slow motion Phase 2 wants. Pacing changes when
      the host sleeps, not what the guest observes, so determinism survives.
- [x] **LEDs and buttons on the page**, and a devicetree describing them:
      four `gpio-leds` and two `gpio-keys`, wired active low with a pull-up
      the way a button usually is, with the `led0` and `sw0` aliases the
      samples look for.
- [x] **Real time.** `--paced` waits out the difference after the guest has
      done the work rather than deciding in advance how long to let it run,
      which is what keeps the guest's clock identical to plain virtual time.
      Blinky now blinks once a second in the browser, and the page has a
      speed control from a quarter to twenty times. `DESIGN.md` D5b.
- [x] **Entropy**, over one import, with the seeded generator as the default
      and `--true-random` as the opt-out, because a real random source would
      end the byte-identical guarantee CI depends on. Both hosts implement
      the same generator from the same seed, so they still agree on a build
      that prints random numbers -- which `tests/drivers/entropy/api` does,
      and which is now in the demo as standing evidence.

`basic/blinky` and `basic/button` now run unmodified, the first with its LED
drawn on the page and the second with a button to press. That is the score at
8, and "my first embedded program" stops being impossible.

`basic/threads`, the third sample this phase was meant to unlock, does not
run and cannot: it declares `void blink0(void)` and hands it to
`K_THREAD_DEFINE`, and wasm type-checks indirect calls. Correcting the three
signatures locally makes it run and toggle LEDs, so nothing else is in the
way. See the note on what "unmodified" can mean, below.

## Phase 2 — see the kernel working

Done, apart from saying what a pending thread is pending on.

- [x] **The thread table**: names, priorities, states, which one holds the
      CPU, and the stack pointer, updated as the run goes. The page does not
      read kernel structures through generated offsets and should not: the
      guest answers instead, through `z_wasm_inspect_threads`, so nothing
      goes quietly wrong when a struct moves. `DESIGN.md` D8e.
- [x] **Pause and single-step**, one context switch at a time. Nearly free,
      because the driver loop is already one step per suspension: "stopped
      between two switches" is a state the host is in thousands of times a
      second anyway. `DESIGN.md` D8f.
- [x] **Slow motion**, which came out of phase 1's pacing: a quarter speed
      to twenty times, changed while the thing is running.
- [x] **Next deadline and pending interrupts**, shown beside the table.
- [x] **Step backwards.** A module is about 128 KB of linear memory, so a
      snapshot is a copy of that plus the host's own bookkeeping, and a
      restore is a write. Stepping forward three switches and back three
      returns the clock, the switch counter and the thread holding the CPU
      to exactly where they were, which the browser check asserts.
      `DESIGN.md` D8g.
- [ ] **Which thread is waiting on what.** The table says `pending`, not
      what it is pending on, and the kernel knows.

## Phase 3 — storage

As the issue has it. Two things it does not mention: IndexedDB is asynchronous
and the driver loop is not, so persistence either goes through a suspending
import or through an image loaded before the run starts and written back after;
and littlefs and FAT are Zephyr modules, so this is the phase where `west.yml`
stops being a two-project manifest and module code starts going through the
section shim.

## Phase 4 — display and input

As the issue has it. Frame pacing depends on Phase 1's real-time work: under
virtual time a render loop has no reason to run at any particular rate.

## Phase 5 — sensors and buses

As the issue has it. `subsys/emul` with the real sensor drivers on top is the
same reuse argument as `gpio_emul`, one layer up.

## Phase 6 — networking

Add a step before the issue's first one: `CONFIG_NET_LOOPBACK` exercises the
whole IP stack, sockets included, with no host work at all. It is the cheapest
possible test of whether the networking subsystem survives this port, and it
should come before any virtual L2 between instances.

## Phase 7 — Bluetooth

As the issue has it, with one dependency it does not name: Zephyr's H4 driver
wants an interrupt-driven UART, and this port's UART is polled because nothing
could fire the interrupt. The interrupt path from Phase 1 is what makes an
interrupt-driven UART possible, and that has to come first.

## Decisions that cut across phases

**Every capability is an import, and there are three hosts.** The ABI is a
closed set, `host/run_wasmtime.py` rejects anything it does not recognise, and
the wasmtime host is a separate implementation on purpose. So each new import
is three edits: the header, the Node and browser core, and the Python host. A
suspending import is a fourth, in the Asyncify import list, and forgetting it
fails silently by never suspending.

**Determinism is a gate, not a preference.** CI requires two byte-identical
runs. Anything that reads a clock, a random number or a user is either seeded,
scripted, or off by default.

**"Unmodified" has a hard edge, and it is not the section shim.** Wasm
type-checks indirect calls, so upstream code that casts a thread entry to
`k_thread_entry_t` traps where every other target shrugs. That is not
fixable here and not worth working around: the honest answer is to fix those
entry points upstream, where the cast is undefined behaviour anyway. The
samples sweep measured the edge: nine upstream applications.

**Iterable sections have an order, and some code depends on it.** Upstream
collects every iterable family with `SORT_BY_NAME`:
- zbus uses that order to group a channel's observers and rank them by
  notification priority;
- log source ids are positions in their section;
- ztest runs in section order;
- the shell lists commands in it.

The port now reproduces the order, and checks the layout from the link map at
every build (`DESIGN.md` D6). Before that, the port kept only link order.
Nothing in the sweep failed on it, but zbus listed its observers in a different
order from upstream, and a channel whose observers were spread across files
could have been mis-grouped.

**Every subsystem added is more Zephyr code through the section shim.** This is
the issue's own first risk and it is the right one. Two of its failure modes
are quiet: a list that reads empty produces no error, just a subsystem that
never initialises; and patch 0007's approximation of `DEVICE_API_EXT_END` is
exact only while no device API class is extended, which is a wrong answer from
`DEVICE_API_IS()` rather than a build failure. GPIO is the first class where
that could bite.

**The browser is the target, not a demo.** `DESIGN.md` still lists browsers as
out of scope, which was true of the original brief and has not been true since
the demo shipped.

## Open questions

* The minimum LLVM version. clang 18 leaves the iterable-section bounds
  undefined and ztest will not link; 21 and 23 are known good. The section
  scheme rests on `__start_`/`__stop_` synthesis and the history of that
  feature is not pinned down.
* How many instances a page can host before it stops being usable, which
  Phase 6 needs an answer to.
* Whether JavaScript Promise Integration should replace Asyncify for the
  browser target. It is the stack-switching backend `DESIGN.md` D3 keeps the
  door open for, it is shipping in Chrome, and it would remove both the
  `wasm-opt` pass and its 1.22x code size. A spike would settle it cheaply.
* Whether the browser backends belong upstream or here.
* Letting people edit and rebuild, which the issue correctly calls the hard cap
  on the whole idea. Precompiled variants per lesson need the manifest and
  nothing else; a build service is a bigger decision and can wait until there
  are lessons to serve.
