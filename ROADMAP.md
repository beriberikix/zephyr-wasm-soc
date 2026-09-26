# ROADMAP — how much of Zephyr can run in a browser tab

[Issue #1](https://github.com/beriberikix/zephyr-wasm-soc/issues/1) sets out the
vision and the phases. This file is the working plan underneath it: the order
the work is actually done in, the things the issue did not account for, and the
decisions that only became visible once someone started costing the phases out.

Where this disagrees with the issue, this file is the newer document.

## The measure

**Upstream Zephyr samples that pass their own acceptance criterion.** Score
today: **44**. 41 pass upstream's own criterion, and three more are counted
from the demo, below.

The number is computed, not claimed. `scripts/check_samples.py` reads every
`tests.yaml` under `zephyr/samples`, keeps the entries that could plausibly run
on a board with no hardware, builds each one exactly as twister would (with
the entry's own `extra_args` and `extra_configs`), runs it, and judges the
output by the entry's own `harness_config` using twister's rules: a console
regex, a ztest verdict, or a scripted shell session. An application counts once
if any of its entries passes. `scripts/samples.json` holds the result for every
entry, with a cause for every one that does not pass, and `scripts/apps.py score`
reads the score from there plus the curated demo in `scripts/apps.json`, which
adds `basic/blinky`, `basic/button` and `input/draw_touch_events`: upstream
gives those no criterion twister can run, because it has no way to watch an
LED or press a button or a screen, so the demo's own checks judge them.

What was tried, out of 650 upstream applications and 1268 entries:

| | entries | applications |
|---|---:|---:|
| Plausible on this board | 230 | 144 |
| Filtered out by upstream's own twister filter | 73 | |
| **Runnable: what twister itself would run here** | **157** | **95** |
| Pass upstream's own criterion | 64 | 41 |
| Build, but upstream only builds them | 9 | |
| Run, with no criterion upstream | 3 | |
| Run and fail their criterion | 1 | |
| Do not finish | 24 | |
| Do not build | 56 | |

The 1039 entries outside "plausible" were not tried, for reasons recorded in
the summary of `samples.json`:
- 655 name only hardware platforms;
- 112 depend on a feature this board does not declare;
- 267 use a harness that needs a peer or a person (networking, Bluetooth,
  sensors, keyboards and so on).

Of the plausible ones, 73 carry a twister `filter:` that is false here:
- `dt_alias_exists("accel0")`, a chosen display or flash controller;
- `CONFIG_ARCH_HAS_USERSPACE`;
- `TOOLCHAIN_HAS_NEWLIB`.

There were 84 until picolibc. `CONFIG_FULL_LIBC_SUPPORTED` and
`CONFIG_PICOLIBC_SUPPORTED` are true now, so eleven entries twister used to
skip here are now run, and judged.

Twister evaluates that after CMake and never runs such an entry on the board.
`check_samples.py` evaluates the same expression with twister's own parser,
against the same build files, and records those entries as filtered. Until it
did, the sweep counted them as failures, and several of them as samples that
"gave up": a sensor sample on a board with no sensors loops for ever printing
nothing.

Three passes are weak and are marked `boot-only` in the record, because
upstream's regex only checks that they started:
`code_relocation_nocopy` ("Hello World!"), `drivers/smbus` and
`drivers/display` (their banners). The display sample passing says nothing
about drawing anything.

Why the runnable rest do not pass, the largest groups first (every entry's
cause is in `samples.json`):

| Cause | entries | what it is |
|---|---:|---|
| Wasm's indirect-call check | 23 | 10 applications, 7 of them zbus; D8b, below |
| Kconfig refuses | 20 | options the board cannot satisfy, e.g. the x86-only `minimal` variants |
| Other build errors | 19 | `logging/syst` (8 entries) needs the mipi-sys-t module, and then `__builtin_return_address`, which wasm lacks; `cpu_freq` needs an SoC P-state API; `llext` wants an ELF toolchain; `cpp/hello_world` and `tflite-micro` need a full C++ library; `debug.fuzz` wants native_sim's `irq_ctrl.h`; the ztest benchmark wants per-arch assembly |
| No such device | 8 | a devicetree node this board has no driver for (`__device_dts_ord_N`): auxdisplay, EEPROM on a bus, ... |
| Link | 4 | `_net_if_list_start` twice (a section bound spelled by hand), `get_bootargs`, `uuid_generate_v5` |
| Overlay does not parse | 4 | x86- or board-specific devicetree overlays |
| Module not imported | 1 | `cmsis_dsp` |
| Fails its regex | 1 | `power.latency` |
| Trap | 1 | `sensing/simple`, an out-of-bounds access |

**D8b is the largest thing between a sample that builds and one that runs.**
Wasm type-checks indirect calls, and before the sweep nobody knew what that
cost. It costs ten applications:
- `basic/threads`;
- seven zbus samples (`hello_world`, `benchmark`, `confirmed_channel`,
  `dyn_channel`, `msg_subscriber`, `runtime_obs_registration`, `work_queue`);
- `cmsis_rtos_v1/philosophers`;
- `cpp/cpp_synchronization`, which got as far as this once the port ran C++
  constructors.

In all but the last, a thread entry is declared `void f(void)` (or
`void f(void *)`) and handed to `K_THREAD_DEFINE`. In the last, the bug is not
in the sample at all but in Zephyr's `zephyr_thread_wrapper`, which calls a
`void (*)(void const *)` through a `void *(*)(void *)`.

Each is a one-line fix upstream, and each is undefined behaviour on every
target. Correcting zbus/hello_world's one signature makes it run in full here.
That makes the upstream signature fixes the most valuable next step for the
score: ten applications for about a dozen lines.

The zbus seven were first recorded as a section-ordering bug. V8 reports a
null function pointer and a wrong signature with the same message, and
`_zbus_init` does depend on the order of its sections, so the explanation fit.
It was wrong. With the signature corrected, zbus/hello_world runs under the
old section layout as well as the new one. The ordering was worth fixing
anyway (see "Iterable sections have an order", below), but it was not what
stopped these samples.

The sweep runs weekly in CI (`.github/workflows/samples.yml`), re-running
everything recorded as working and failing if any of it got worse. Dispatching
that workflow with `everything` re-runs all 230 entries, which is how an
improvement gets noticed.

"Unmodified" is enforced by construction: a sample that needs a `prj.conf`
edit or a source change is not counted. Devicetree overlays under `boards/`
are allowed, because that is how every real board configures a sample, and a
board overlay is not a change to the sample.

The demo page is counted the same way. `scripts/apps.json` is the one list of
what the page offers, `scripts/stage_site.sh` turns it into
`_site/manifest.json`, and `scripts/check_site.mjs` runs every entry and
asserts the output it is supposed to produce.

## Where things stand, and what is next

Phases 0 to 4 are done, apart from the small items still open in each. The
score went from 3 to 44. Phases 5 to 7 have not started.

What comes next, in order, and why:
1. **Send the D8b fixes upstream.** They are prepared and checked in
   `upstream/zephyr/`: ten applications, `basic/threads` among them, and two
   kernel suites. Sending them is a person's job, since Zephyr needs the
   submitter's own `Signed-off-by`.
2. **Phase 5, sensors**, before networking: eight samples are filtered out
   only for want of a part upstream already emulates, and one of them puts a
   live chart on the page.
3. **The Phase 6 loopback spike**, the cheapest evidence on whether the IP
   stack survives this port.
4. **The first lesson**, with "which thread is waiting on what" before it.
5. **A C++ standard library**, now that picolibc builds (below, "Two
   levers"). Last, because it waits on two applications, one of which also
   needs a module.

The C library spike that was first on this list is done: picolibc builds,
three more samples pass, and C++ constructors run (below, "Two levers").

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
- [ ] **The two suites that do not finish for unknown reasons**:
      `threads/thread_apis` and `sched/schedule_api`. There were three.
      `mem_heap/k_heap_api` passes all 23 cases now that iterable sections
      are in upstream's order, because ztest now runs the cases in upstream's
      order too. In link order, a case that ran earlier left the heap's
      spinlock held. Which case that was is still unknown; upstream's order
      simply never exposes it.
- [ ] **Timer accuracy.** `common`, `timer/timer_api` and
      `tickless/tickless_concept` all fail on how long something took, which
      is one question wearing three hats: a slice ends at the next safepoint
      rather than on the tick.
- [x] **The manifest and the score**, as above. The score is now the
      samples sweep; see the measure.
- [ ] **Twister.** It builds for this board but cannot find the module's SoC,
      because it takes a `--board-root` and no `--soc-root` and relies on
      module discovery, which finds nothing when the module is the manifest
      repository. Until that is solved the scoreboard is
      `scripts/check_samples.py`, which applies twister's own rules without
      twister. Half done: `wasm_node.yaml` now has the `supported:` list
      (`26fe63b`), so twister will not filter the board out of every
      `depends_on` test once it can build them.
- [x] **Logging.** Already works. `CONFIG_LOG` was on this list because
      nearly every sample past `basic/` calls `LOG_INF` and because it brings
      three more iterable families with it, which made it the first real test
      of the section shim under something not written with this port in mind.
      The shim passed: `samples/subsys/logging/logger` runs unmodified and
      deterministically.
- [x] **Tracing and CPU load see interrupts and idle.** The dispatcher now
      calls `sys_trace_isr_enter/exit` around each handler, and both idle
      paths call `sys_trace_idle/idle_exit` around the host wait, as every
      other architecture does. Before this, tracing backends and CPU load
      silently saw neither. `samples/subsys/tracing/basic`'s gpio entry
      checks for it.
- [x] **Make stack overflow loud.** The Asyncify buffer is not bounds-checked,
      and Binaryen will not add a check, but the host can: the buffer's cursor
      and limit are two words in linear memory, so both hosts compare them
      after every unwind and stop the run with a message naming the buffer
      and how far it overran (`a696395`). It is after the fact, but it turns
      silent corruption into a reported fatal.
- [ ] **`CONFIG_STACK_SENTINEL`**, which covers the C shadow stack, the other
      half of a thread's stack. Not on yet, and not tried.
- [x] **Build hygiene** (`10d1bdc`). The safepoint pass's skip of
      `z_wasm_switch` matched nothing because the function was not exported;
      it is exported now, and a skipped name that cannot be found fails the
      build. The dead `ITERABLES` dict is gone. `llvm-ar` is looked for
      beside clang and missing is an error. `tools.env` warns below LLVM 21.
- [x] **Documentation drift** (`10d1bdc`). The patch count, the browser
      scope and the dead link to a deleted report are fixed, and `DESIGN.md`
      now says the brief's browser exclusion no longer holds.

Unknowns that Phase 0 was expected to turn up:
- **The heap** works: `basic/sys_heap` passes, and so does
  `tests/kernel/mem_heap/k_heap_api`.
- **`%f` works.** With `CONFIG_CBPRINTF_FP_SUPPORT`, `printf` and `printk`
  both format floats under the minimal libc, and picolibc's own `printf`
  does too.
- **`CONFIG_MULTITHREADING=n`** is still untested. The `basic/minimal`
  variants that set it are x86-only upstream and refuse this board in
  Kconfig, so the sweep never reached it.

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

- [x] **Flash and EEPROM.** Upstream's flash simulator and EEPROM simulator,
      as native_sim has them, with a 64 KB storage partition. The flash is
      256 KB because it lives in linear memory, which every step-back
      snapshot copies. Six more upstream samples pass:
      - settings on NVS;
      - ZMS (all three entries);
      - `kvss/nvs`;
      - `drivers/eeprom`;
      - `flash_shell` (a scripted shell session).
- [x] **Warm reboot.** `sys_reboot()` is a new instance of the module with
      the flash carried over, as a reset keeps flash on hardware. `kvss/nvs`
      reboots itself five times and counts the reboots in flash.
- [x] **Persistence.** The flash survives the run: `--flash <file>` in both
      hosts, and IndexedDB on the page, with an "Erase flash" button. The
      browser check reloads the page between two runs of `kvss/nvs` and
      requires the second to find what the first stored.

      It took no suspending import. The host fills the array from a saved
      image at attach time and reads it back whenever the guest is paused,
      so nothing in the guest waits for storage (`DESIGN.md` D8h).
- [x] **File systems.** `west.yml` imports `fatfs` and `littlefs` through
      Zephyr's own manifest, at Zephyr's pins, and nothing else.
      - `fs/fatfs_fstab` and `fs/ext2_fstab` pass their criterion, each on a
        RAM disk its own overlay declares.
      - The two `fs/format` entries and `fs/littlefs` build; upstream only
        builds them.
      - Run by hand, `fs/littlefs` mounts the board's storage partition,
        formats it the first time and keeps a boot counter. With `--flash`
        or in the browser, that counter survives the run.

      Two port bugs turned up on the way, and both would have hit other
      code:
      - `arch.h` did not include `<zephyr/devicetree.h>`, which every
        in-tree arch does and which ext2 relies on.
      - The safepoint pass did not understand a debug build's named
        functions, so any `CONFIG_DEBUG=y` sample failed after linking.
- [ ] **EEPROM persistence.** The EEPROM simulator has no accessor for its
      array, so it is RAM for one run only.

## Phase 4 — display and input

- [x] **A display the page draws.**
      - `wasm,host-display` is a 320×240 RGB565 framebuffer in linear memory.
        RGB565 is LVGL's default colour depth, so its samples need no board
        configuration.
      - The guest names the framebuffer and reports each rectangle it writes.
        The host reads the pixels between steps and draws them on a
        `<canvas>`. Nothing waits, the same arrangement as the flash
        (`DESIGN.md` D8i).
      - `--screenshot` in both hosts. Frames are identical across runs and
        across V8 and wasmtime.
- [x] **Touch and keys.**
      - `wasm,host-input` feeds the input subsystem from an interrupt with
        what native_sim's SDL touch reports.
      - On the page, pressing on the canvas is a touch and typing into it is
        keys. `--touch` and `--key` script them under Node, repeatably.
      - `draw_touch_events` draws its crosshair where the browser check
        clicks.
- [x] **LVGL.**
      - `west.yml` imports it, and the board gives it a pointer.
      - All seven `modules/lvgl/demos` entries pass their upstream
        criterion, unmodified.
      - On the page, the widgets demo can be touched: a tap on its tabs
        switches them.
- [ ] **Frame pacing** is Phase 1's paced clock, and is enough for the demos.
      A render loop tied to the browser's frame rate would be smoother. It
      would need the host to wake the guest per frame, and nothing here asks
      for that yet.

## Phase 5 — sensors and buses

As the issue has it. `subsys/emul` with the real sensor drivers on top is the
same reuse argument as `gpio_emul`, one layer up.

The sweep says where to start. Eight samples are
filtered out here for want of one devicetree alias, and upstream ships an
emulator for a part of each kind:

| Alias | Samples | Upstream emulators |
|---|---|---|
| `accel0` | `sensor/accel_polling`, `accel_stream`, `accel_trig`, `lvgl/accelerometer_chart` | `bmi160`, `bma4xx` |
| `pressure-sensor` | `sensor/pressure_polling`, `pressure_interrupt` | `bmp581` |
| `stream0` | `sensor/6dof_fifo_stream`, `stream_drdy` | `icm4268x` |

Whether each sample's trigger or streaming mode works against its emulator
is the work; the parts exist. `lvgl/accelerometer_chart` is the one to aim
at, since it puts a driver talking to a bus on the page as a moving chart.

- [ ] An emulated I2C bus with an accelerometer on it, aliased `accel0`.
- [ ] The pressure sensor and the streaming IMU, the same way.
- [ ] Optionally, the browser's Generic Sensor API behind the emulator, so
      tilting a phone moves the chart.

## Phase 6 — networking

Add a step before the issue's first one: `CONFIG_NET_LOOPBACK` exercises the
whole IP stack, sockets included, with no host work at all. It is the cheapest
possible test of whether the networking subsystem survives this port, and it
should come before any virtual L2 between instances.

The sweep has not touched networking: 106 entries use twister's `net`
harness, which needs a peer, so none was tried. The loopback spike is the
first evidence either way.

## Phase 7 — Bluetooth

As the issue has it, with one dependency it does not name: Zephyr's H4 driver
wants an interrupt-driven UART, and this port's UART is polled because nothing
could fire the interrupt. The interrupt path from Phase 1 is what makes an
interrupt-driven UART possible, and that has to come first.

## Two levers on the score that no phase covers

The sweep's record of what does not pass says where the next samples are,
and the two largest groups are not in any phase.

- [x] **A full C library.** Picolibc now builds from its module for wasm32,
      and a sample that asks for it gets it. Three samples pass that could
      not before: POSIX `env`, `uname` and `philosophers`. Four changes in
      the port and one patch to picolibc:
      - wasm is little-endian, which picolibc's `<machine/ieeefp.h>` cannot
        work out for wasm32 without being told;
      - the wasm-ld link puts picolibc's `libc.a` last, as lld does;
      - `malloc` gets a fixed 16 KB arena, native_sim's answer to having no
        linker script to define `_end`;
      - the arch provides the three 128-bit helpers clang calls and nothing
        here supplied (`__multi3`, `__ashlti3`, `__lshrti3`), because there
        is no compiler-rt for wasm32;
      - `patches/picolibc/0001` leaves out a `.fini_array` entry the wasm
        backend refuses. Zephyr never runs that array on any target.

      `setjmp`/`longjmp` was the expected snag and never came up: nothing
      tried needed it.

      Two more changes came out of the same samples:
      - C++ static constructors now run. wasm-ld collects them into
        `__wasm_call_ctors()`, and the kernel's init list now calls it at
        the same point in boot as on every other target. Before this, no
        constructor ran, in C or C++.
      - A dynamically allocated thread stack defaults to the Asyncify
        buffer's size, 4 KB. `PTHREAD_STACK_MIN` is that size on wasm, so
        the kernel's default of 1024 made `pthread_create()` refuse every
        thread.

      Of the ten applications picolibc was expected to help, the rest need
      something else first:
      - `cpp/cpp_synchronization` now reaches D8b;
      - `cpp/hello_world` and `tflite-micro` need a full C++ standard
        library, which this toolchain does not have for wasm32;
      - `logging/syst` needs the mipi-sys-t module, and then
        `__builtin_return_address`, which clang does not implement for wasm;
      - `cmsis_dsp` needs its module;
      - POSIX `eventfd` stops at the link on `_net_if_list_start`;
      - the ztest benchmark wants per-architecture assembly.
- [ ] **A C++ standard library.** `cpp/hello_world` and anything else that
      sets `REQUIRES_FULL_LIBCPP` needs libc++ or libstdc++ built for
      wasm32. Picolibc was the prerequisite for that, and it is done.
- [ ] **Propose the D8b signature fixes upstream.** Prepared and checked;
      waiting on someone to send them. `upstream/zephyr/` holds six patches,
      one per maintainer area:
      - the CMSIS-RTOS v1 thread wrapper, a library bug rather than a sample
        one;
      - `basic/threads`, `cpp_synchronization` and seven zbus samples;
      - the mutex and pending kernel tests.

      Each gives a thread entry the signature `k_thread_entry_t` declares.
      Clang's `-Wcast-function-type-strict` found the sites, including two the
      first triage had missed: the zbus benchmark's `int`-returning consumers
      and a second entry in `msg_subscriber`. The series applies to the pin
      and to upstream `main`, and checkpatch finds nothing but the missing
      `Signed-off-by`, which Zephyr requires a person to add.

      `scripts/try_upstream.sh` applies it for one run. All 23 entries pass,
      so all ten applications, and both kernel suites finish and pass. With
      the series the score would be 54. It stays 44 until Zephyr takes the
      patches and the pin moves, because "unmodified" means upstream's tree.

## Lessons

The issue asks two things: how much of Zephyr runs in a tab, and whether that
is a good way to learn it. The score answers the first, and has gone from 3
to 44. Nothing yet answers the second. The page runs samples; it does not
teach with them, and nobody learning Zephyr has tried it.

- [ ] **One lesson**, to find out what a lesson needs. `philosophers` is the
      obvious first: five threads contending for forks is what pause, step,
      step back and the thread table were built to show. A lesson is a build
      from the manifest plus a short script of what to do and what to watch
      for, the "precompiled variants per lesson" the issue already chose.
- [ ] **Which thread is waiting on what** (Phase 2's open item) comes first,
      because "blocked on fork 3, which philosopher 2 holds" is the lesson.

The score stays the measure. A lesson is how the page gets tested by the
people it is for.

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
samples sweep measured the edge: ten upstream applications. See "Propose
the D8b signature fixes upstream", above.

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
the issue's own first risk, and so far it has held up better than feared:
after four phases, 44 samples, three file systems and LVGL there are still
seven patches to Zephyr, and one to picolibc. Its real failures were archive members whose names collided
and sections in the wrong order, both fixed and both now checked at every
link. Two of its failure modes
are quiet: a list that reads empty produces no error, just a subsystem that
never initialises; and patch 0007's approximation of `DEVICE_API_EXT_END` is
exact only while no device API class is extended, which is a wrong answer from
`DEVICE_API_IS()` rather than a build failure. GPIO is the first class where
that could bite.

**The page runs long, interactive sessions, and needs checks that do the
same.** Until PR #5 every check ran a build to its end in seconds and read
the result through hooks. Nothing typed into the terminal, nothing ran for
more than a few seconds, and nothing pressed a button the way a person does.
The first walkthroughs by hand, and in Claude in Chrome, found about a dozen
bugs in a week, none of which any check could have seen:
- the terminal dropped escape sequences, so backspace and the cursor did
  nothing;
- every run froze or ended at 100 s of guest time, because the kernel's
  "nothing soon" clamp was recognised by its absolute value (`DESIGN.md`
  D5a);
- the input queue overflowed under the paced clock;
- the paced clock ran slower than the wall clock;
- a second quick press of a button was lost.

So the rules now:
- the browser check drives the page with the real keyboard and mouse, never
  a hook, and checks what is on the screen;
- CI runs a build past 100 s of guest time on both engines;
- the page's footer names the commit it was built from, so a report from a
  walkthrough maps to code;
- `scripts/apps.json` says which parts of the board each build uses, and
  staging checks that against the build's `.config`;
- a walkthrough by a person, or by an agent acting like one, comes before a
  page change is called done.

- [ ] **Check in the walkthrough prompt**, so the next one tests the same
      things and quotes the build it tested.

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
  on the whole idea. Precompiled variants per lesson are chosen for now: the
  manifest already is that, and costs nothing to extend. A build service is a
  bigger decision and waits until a lesson shows what people want to change.
