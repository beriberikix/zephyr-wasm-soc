# ROADMAP — how much of Zephyr can run in a browser tab

[Issue #1](https://github.com/beriberikix/zephyr-wasm-soc/issues/1) sets out the
vision and the phases. This file is the working plan underneath it: the order
the work is actually done in, the things the issue did not account for, and the
decisions that only became visible once someone started costing the phases out.

Where this disagrees with the issue, this file is the newer document.

## The measure

**Upstream Zephyr samples that pass their own acceptance criterion.** Score
today: **109**. 62 pass upstream's own criterion, and 47 more are counted
from the demo, below.

The number is computed, not claimed. `scripts/check_samples.py` reads every
`tests.yaml` under `zephyr/samples`, keeps the entries that could plausibly run
on a board with no hardware, builds each one exactly as twister would (with
the entry's own `extra_args` and `extra_configs`), runs it, and judges the
output by the entry's own `harness_config` using twister's rules: a console
regex, a ztest verdict, or a scripted shell session. An entry that needs a
twister fixture runs only if this board has it, as on a bench: the display,
and the thermometer `sensor/thermometer`'s board files attach. An application
counts once if any of its entries passes. `scripts/samples.json` holds the result for every
entry, with a cause for every one that does not pass, and `scripts/apps.py score`
reads the score from there plus the curated demo in `scripts/apps.json`, which
adds `basic/blinky`, `basic/button`, `input/draw_touch_events`,
`drivers/uart/echo_bot`, which the demo types into, two LVGL
samples with nothing upstream checks, `display/lvgl` and
`smf_calculator`, whose screens and consoles the demo checks, and the
fourteen network samples the two-board pairs run: the echo client and four
echo servers, the CoAP server and three CoAP clients, HTTP's client and
server, zperf, which is both ends of its own pair, and `dns_resolve` with
`mdns_responder`; `dhcpv4_client`, `http_get`, `dumb_http_server`,
`tftp_client`, `sntp_client`, `ftp_client`, `prometheus` and
`mqtt_publisher`, whose peer
is the host's own network; `promiscuous_mode` and `pkt_filter`, which the
host's network pings; `net_mgmt`, `stats`, `virtual` and `vlan`, which
need an interface but no one to talk to; and thirteen Bluetooth samples
the radio pairs run: `peripheral_hr` with `central_hr`, `peripheral_ht`
with `central_ht`, `peripheral_gatt_write` with `central_gatt_write`, which
pair and encrypt, `central` with `peripheral_csc`, and `observer` hearing
`beacon`, `broadcaster`, `ibeacon` and `eddystone`.
Upstream gives those no criterion twister can run, because it has no
way to watch an LED, press a button or a screen, type, or give a board a
peer, so
the demo's own checks judge them.

**What "unmodified" means for a pair.** The source is never touched. A single
board is built only as upstream's own test entry builds it, with this board's
own files for the sample where it has them (below). A pair's boards
may also be given build arguments that put two boards on one network, and
nothing else:
- the link itself (`-DSNIPPET=wasm-ethernet`), or for a Bluetooth pair the
  radio (`-DSNIPPET=wasm-bt`);
- addresses (`NET_CONFIG_MY_*` and `PEER_*`);
- sample-specific peers, ports and resource names;
- switching off an IP version the other board does not speak.

The rule is needed because nearly every upstream network client is set up
to talk to a Linux host at `192.0.2.2`, not to a second Zephyr board, and no
upstream file sets them up to talk to each other. `scripts/apps.py` enforces
the list (`PAIR_ARG`) and refuses anything else, a buffer size for
instance. Each entry that uses it says in words what was set, and the page
shows that under the entry's hint. This is looser than twister's own
criterion, which is why it is spelled out: of the 96, ten count only
because of it: the CoAP server with its three clients, HTTP's client and
server, zperf, the mDNS pair, and `sntp_client`, pointed at its server.
The five echo samples pair as shipped.

**A board's own files for a sample.** Upstream keeps what a sample needs on
native_sim in the sample's `boards/native_sim.overlay` and `.conf`: the
devices it uses there, and options that board needs for it. This board has
the same, in `boards/wasm/wasm_node/apps/<path>/wasm_node.overlay` and
`.conf`, applied exactly as Zephyr applies a board's own (DESIGN.md D12).
They may be an overlay and a Kconfig fragment and nothing else: never
source, which `scripts/sweeplib.py` refuses. The sample record marks every
entry built with them, and the page says so. Six samples count with them:
`flow_meter`, `fingerprint`, `thermometer`, `sensing/simple`, `pm/latency`
and `video/capture`.

**And for a board on a real network.** Its peer is a relay (`DESIGN.md`
D8l), and it is built as upstream ships it with the link turned on, and
nothing else: `apps.py` refuses any other argument for an `uplink` entry.
The relay gives it its address. CI runs a relay on loopback, and checks
only what the relay answers itself, a DHCP lease, so the count does not
depend on the internet.

**And for a board on the host's own network** (`DESIGN.md` D8m). The host
plays the Linux host the samples expect at `192.0.2.2`, so the pair rule
applies with the LAN as the peer: the same `PAIR_ARG` list, with
`overrides` saying what was set. It runs on the board's clock, so each of
these is checked twice, like a pair, and must say the same both times.
A sample whose upstream entry `depends_on: netif` and needs no peer
(`net_mgmt`, `stats`, `virtual`, and `vlan`, whose entry `depends_on:
eth`) is built the same way: its interface is the one the snippet gives,
plugged into the LAN so what it sees is a repeatable wire.

**Which entries could run here at all** is one rule for the sweep and the
demo alike. An entry whose `platform_allow` names only hardware is left
out. One whose list names a simulator (native_sim, qemu, native_posix)
counts as runnable without hardware, since upstream runs it that way
itself. That is what `scripts/check_samples.py` has always applied. The
network demo applied a stricter one for a while, and left out
`ipv4_autoconf` and the two MQTT publishers for having such lists. It now
applies the same one.

A sample the LAN serves counts only if it passes on Zephyr as this
workspace pins it. `websocket_client` and `coap_client_tcp` run against the
LAN's WebSocket and CoAP services only with a fix to Zephyr, so they do not
count yet (D8m); nor does `dumb_http_server_mt`, which traps on its thread
entries (`upstream/zephyr/0014`), nor `mqtt_sn_publisher`, which traps on
its thread entry (0015), nor `ipv4_autoconf`, which registers for the event
it prints after the event has happened here (0016). `big_http_download` checks the SHA-256 of
an Ubuntu kernel it downloads, which the LAN could only fake, so it is
left for a real network.

What was tried, out of 650 upstream applications and 1268 entries:

| | entries | applications |
|---|---:|---:|
| Plausible on this board | 230 | 144 |
| Filtered out by upstream's own twister filter, or a fixture | 68 | |
| **Runnable: what twister itself would run here** | **162** | **102** |
| Pass upstream's own criterion | 88 | 59 |
| Build, but upstream only builds them | 13 | |
| Run, with no criterion upstream | 5 | |
| Run and fail their criterion | 0 | |
| Do not finish | 25 | |
| Do not build | 31 | |

Every entry is built with Zephyr's default C library, picolibc, as on any
other board. Until the mDNS pair the board forced the minimal libc, and the
whole record was re-measured when it stopped (`DESIGN.md` D11). Nothing got
worse, and the 47 did not move: three entries that stopped on a function the
minimal libc lacks now build, `strcasecmp`, `strpbrk` and `strtod`. One of
them, `smf_calculator`, runs, but has no upstream criterion to pass.

The 1039 entries outside "plausible" were not tried, for reasons recorded in
the summary of `samples.json`:
- 655 name only hardware platforms;
- 112 depend on a feature this board does not declare;
- 267 use a harness that needs a peer or a person (networking, Bluetooth,
  sensors, keyboards and so on).

Of the plausible ones, 66 carry a twister `filter:` that is false here:
- `dt_alias_exists("stream0")`, a chosen flash controller or bus;
- `CONFIG_ARCH_HAS_USERSPACE`;
- `TOOLCHAIN_HAS_NEWLIB`.

There were 84 until picolibc, and 73 until the sensors. Picolibc made
`CONFIG_FULL_LIBC_SUPPORTED` and `CONFIG_PICOLIBC_SUPPORTED` true, and Phase 5
added `accel0` and `pressure-sensor`, so eighteen entries twister used to skip
here are now run, and judged. One of them, `smf_calculator`, had been recorded
as wanting a display long after the board had one.

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
| Wasm's indirect-call check | 24 | 11 applications, 7 of them zbus; D8b, below |
| Other build errors | 6 | `llext` (2) wants an ELF toolchain; `debug.fuzz` wants native_sim's `irq_ctrl.h`; the ztest benchmark wants per-arch assembly; dictionary logging and a Bluetooth monitor UART |
| Kconfig refuses | 10 | options the board cannot satisfy, e.g. the x86-only `minimal` variants |
| No such device | 6 | a devicetree node this board has no driver for (`__device_dts_ord_N`): auxdisplay, EEPROM on a bus, ... |
| Link | 1 | `get_bootargs` |
| Overlay does not parse | 3 | x86- or board-specific devicetree overlays |
| Gives up | 1 | `dhcpv4_client`, waiting for a DHCP server one board does not have |

**D8b is the largest thing between a sample that builds and one that runs.**
Wasm type-checks indirect calls, and before the sweep nobody knew what that
cost. It costs eleven applications, and ten of them are thread entries:
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

The eleventh, `posix/eventfd`, got this far once the port reached its
`main(argc, argv)` (DESIGN.md D8b). The bug is in Zephyr's file layer: it
calls every file's `write_offs()`, which only shared memory fills, and
eventfd, sockets and the console fill `write()`.

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
score went from 3 to 96. Phases 5, 6 and 7 have started. The first
lesson is on the page.

What comes next, in order, and why:
1. **Send the D8b fixes upstream.** They are prepared and checked in
   `upstream/zephyr/`: ten applications, `basic/threads` among them, two
   kernel suites and two network suites. With them go the QUIC and CAN
   socket fixes, 0011 for the echo servers' IPv6 address buffers, 0012 for
   the minimal libc's missing `strcasecmp`, 0013 for the CoAP-over-TCP
   client's first millisecond, 0014 and 0015 for `dumb_http_server_mt`'s
   and `mqtt_sn_publisher`'s thread entries, 0016 for `ipv4_autoconf`'s late
   registration, 0017 for the file layer's `read` and `write`, which traps
   `posix/eventfd`, and one for mbedTLS in `upstream/mbedtls/`. Sending them is a person's job,
   since Zephyr needs the submitter's own `Signed-off-by`.
2. **Phase 5, the rest.** The bus, an accelerometer the page can tilt and a
   pressure sensor are done. Triggers and FIFO streaming wait on an upstream
   emulator that drives an interrupt pin; the chart waits on pixel loops
   being cheaper.
3. **Move Zephyr's pin.** The LAN already serves WebSocket and CoAP over
   TCP. `websocket_client` passes against it once the pin takes upstream's
   Kconfig fix, and `coap_client_tcp` once 0013 lands; moving the pin is
   also what counts any of the D8b fixes Zephyr has taken. QUIC's pair
   waits on patch 0007, and the relay's static-address samples on
   `upstream/rootlessrelay/0001`.
4. **Someone learning Zephyr tries the lesson.** It is built and checked,
   but whether it teaches is a question only its audience can answer, and
   what they get stuck on should decide the second lesson.

The C library spike that was first on this list is done: picolibc builds,
three more samples pass, and C++ constructors run (below, "Two levers"). So
is the first lesson, with the thread table's answer to what each thread is
waiting for (below, "Lessons"), and so is mbedTLS, which raised the score by
four. So is diagnosing the network suites' indirect-call traps, most of
which were a stack overflow in the port. Between them, and picolibc as the
default C library, 125 of 139 network suites now pass (Phase 6). And so is the virtual L2: two boards on the
page, echoing over Ethernet, which raised the score to 52, seven more
pairs, which took it to 61, and zperf, typed into on both boards, which
took it to 62. The pairs now run on one clock, so each is as repeatable
as a single board, and the mDNS pair, once the board took Zephyr's default
C library, took it to 64. `dhcpv4_client`, leased an address by a real
relay, took it to 65. The host's own network, lwIP on the board's clock,
took it to 69 with `http_get`, `dumb_http_server`, `tftp_client` and
`sntp_client`, and three samples that need an interface but no peer,
`net_mgmt`, `stats` and `virtual`, took it to 72. More services on the
LAN, FTP and pings and a page asked for by path, with promiscuous mode and
VLANs in the Ethernet driver, took it to 77 with `ftp_client`,
`prometheus`, `promiscuous_mode`, `pkt_filter` and `vlan`. Two LVGL
samples took it to 79: `display/lvgl`, and `smf_calculator`, once the board
turned input on for LVGL and a debugging build got the C stack it needs
(DESIGN.md D8). An MQTT broker on the LAN took it to 80 with
`mqtt_publisher`, once the demo counted entries by the sweep's rule.
Importing the `cmsis-dsp` and `nanopb` modules took it to 82: both samples
ran as they are. P-states on the SoC, semihosting through the host
(DESIGN.md D8n) and the `mipi-sys-t` module took it to 86 with both
`cpu_freq` samples, `tracing/pipeline` and `logging/syst`. This board's own
files for a sample, as upstream keeps native_sim's, took it to 92 with
`flow_meter`, `fingerprint`, `thermometer`, `sensing/simple`, `pm/latency`
and `video/capture`. A wasm32 sysroot with picolibc and libc++, as the
Zephyr SDK provides for other architectures (DESIGN.md D13), took it to 93
with `cpp/hello_world`. Importing two of Zephyr's optional C++ modules took
it to 95: TensorFlow Lite Micro's `hello_world` ran as it is, and CHRE did
once cbprintf's `long double` check skipped wasm as it skips the other
targets whose `long double` is 16-byte aligned (`patches/0008`). The same
patch let `logging/syst`'s deferred C++ variants build. An interrupt-driven
UART, Phase 7's first step, took it to 96 with `drivers/uart/echo_bot`,
typed into on the page as `basic/button` is pressed. A Bluetooth controller
behind H4, the second step, took it to 100 with two radio pairs: the
heart-rate sensor and monitor, and a beacon and an observer. Encryption in
the controller took it to 102 with the GATT write pair, which pairs and
encrypts before it writes, and five more pairs the controller already
supported took it to 109: the health thermometer, `central` with a cycling
sensor, and three beacons for the observer.

**A browser test, 28 September.** A browser agent ran every build on the
live site as a person would, from a written test plan, and read the output
the way the checks do. It found no console errors and no build that
failed outright, and six that were only partly right. Four of those were
real:
- **The accelerometer's terminal stayed blank for eight seconds.** The
  page's first reading raised an interrupt before its driver had enabled
  the line, and time stood still until the driver did. Both the host and
  the guest's idle now look only at interrupts the guest can take, and the
  host holds a line back until it is enabled (`DESIGN.md` D8d). The
  accelerometer check now sends a reading at 0 ms, as the page does.
- **Stepping back left the undone steps' output on the screen**, so
  stepping forward again printed it twice. The terminal now goes back with
  the kernel (`DESIGN.md` D8g), and the browser check steps until
  something is printed, back as far, and forward again.
- **The echo servers printed an empty address for IPv6 clients.** That is
  upstream's: a 32-byte buffer for a 46-byte address. Patch 0011.
- **The HTTP client's POSTs come back 404 and 405.** Also upstream's: the
  client was written for a test server on a Linux host, and its paths are
  fixed in its source. The hint says so now.

Smaller ones, fixed with them:
- the thread holding the CPU was shown as "queued", and is now "running";
- the timer driver set its alarm early by however long a busy-wait had
  run, so the status line showed a deadline that had already passed;
- the speed and the last build chosen are now kept across a reload, as the
  help text said they were;
- the terminal now follows a page theme set with `data-theme`;
- builds that only print now wrap to a phone's width;
- the first lesson step no longer says to press Run when the build is
  already running;
- an error from a run the page had already let go of could reach the next
  one's terminal.

The other two partial results came from mistakes in the test plan.

A second run, after those fixes and the zperf pair, passed everything. It
checked all ten fixes, the new pair over IPv4 and IPv6, and every other
build. It found one rough edge. Stop, or a change of build, left the old
run's Worker going until it noticed, which could be seconds, so a quick Run
booted slowly beside it. The page now ends the Worker at once
(`DESIGN.md` D8h).

## Phase 0 — foundations

The issue starts at Phase 1. It lists "the kernel evidence is one test suite"
under risks and then never schedules it. Everything above the kernel stands on
the kernel, so this comes first.

- [x] **Run the rest of `tests/kernel`.** Done, and it was worth doing: 25
      suites and 441 passing cases, against one suite before. 16 passed
      outright at first, 4 finished with failures and 5 did not finish;
      now 22 pass (below).
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
- [x] **The two suites that do not finish for unknown reasons**, and
      **timer accuracy.** Both had port causes, and the theory for the
      second was wrong. `common`, `timer/timer_api`,
      `tickless/tickless_concept` and `sched/schedule_api` were put down to
      a time slice ending at the next safepoint rather than on the tick.
      All four measure with `k_busy_wait()`, and the busy-wait replaced the
      kernel timer's alarm with its own, so a timer due during the wait
      fired only after it. The wait now stops at the kernel's deadline
      too, and takes the interrupt there (`DESIGN.md` D8d).
      `threads/thread_apis` trapped where an essential thread aborts
      itself: the kernel panics after the thread is already dead and then
      switches away, which needs the fatal path to return, as arm64's
      does. 22 of 25 suites now pass, and the other three are patch 0007
      and D8b.
- [x] **The manifest and the score**, as above. The score is now the
      samples sweep; see the measure.
- [x] **Twister.** It runs: `scripts/twister.sh` passes the module as
      `ZEPHYR_EXTRA_MODULES`, which is how twister's module discovery finds
      the board's SoC and arch when the module is the manifest repository,
      with the toolchain arguments every build needs. Three things stood in
      the way after that:
      - twister reads a ztest suite's cases from the ELF symbol table, and a
        wasm image is not ELF (`patches/0009` takes them from the output);
      - `CONFIG_DEBUG_THREAD_INFO` ends in a `#warning` for an architecture
        it does not list, which twister's warnings-as-errors build refuses
        (`patches/0010`);
      - a sample that never ends reached `--max-time` before twister, which
        waits two seconds after its harness matches, stopped it, and the
        host's give-up exit failed it. The board's `run` target now stops
        cleanly there (`--stop-at-max-time`).

      Under twister, the semaphore, queue, common (seven configurations)
      and thread suites pass, and so do `hello_world`, `synchronization`
      and all nine `philosophers` configurations. `check_samples.py` stays
      the scoreboard: it records a cause for every entry, and twister needs
      Zephyr's test requirements, which the build does not.
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
- [x] **`CONFIG_STACK_SENTINEL`**, which covers the C shadow stack, the other
      half of a thread's stack. It works, once the stack was laid out as
      Zephyr describes it: the reserved bytes are at the bottom of a stack
      object, and the Asyncify buffer now lives there, so `stack_info.start`
      is the bottom of the C stack (`DESIGN.md` D8). The architecture's part,
      a check after every interrupt that is not nested, is in
      `z_wasm_irq_dispatch()`. Upstream's `tests/kernel/fatal/exception`
      catches both its deliberate overflows, from a timer interrupt and from
      a swap, and the whole suite passes since a trap became a CPU
      exception (below).
- [x] **A trap is a CPU exception** (`DESIGN.md` D14). A call through a bad
      pointer or with the wrong signature, or a division by zero, used to
      end the board with a JavaScript stack trace. The trap unwinds only the
      running thread's frames, so the host now enters the guest again on
      that thread's behalf and Zephyr handles a `CPU exception` as on
      hardware: the default handler halts the board with the reason, and a
      handler that returns has the thread aborted while the rest carry on.
      `tests/kernel/fatal/exception` passes as it is, which makes 23 of 26
      kernel suites. A halt no longer ends in a stack trace either. The
      sweep now fails any run that reports a fault, as twister does, so a
      sample with one dead thread cannot pass on its others' output.
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

Done.

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
      to exactly where they were, which the browser check asserts. What
      the undone steps printed is taken back as well. `DESIGN.md` D8g.
- [x] **Which thread is waiting on what.** A "waiting for" column: the
      mutex a thread waits on and which thread holds it, the address of any
      other kernel object, and how long is left before a sleeping thread
      wakes or a waiting one gives up. The guest works out the mutex's
      owner, and tells a mutex from other objects by checking that what it
      finds is a thread holding the lock (`DESIGN.md` D8e). Watching the
      philosophers this way shows priority inheritance at work, which
      nothing on the page showed before: a philosopher holding a fork runs
      at the priority of the one waiting for it.

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

What happened to each:

| Sample | Result |
|---|---|
| `accel_polling` | passes upstream's regex, unmodified |
| `accel_stream` | passes: without `SENSOR_ASYNC_API` it polls |
| `accel_trig` | runs and fails: `sensor_trigger_set()` returns `-ENOSYS` |
| `pressure_polling`, `pressure_interrupt` | build, which is all upstream asks |
| `lvgl/accelerometer_chart` | runs, with no criterion upstream; slower than real time |
| `6dof_fifo_stream`, `stream_drdy` | still filtered: no `stream0` |

- [x] **An emulated I2C bus with an accelerometer on it**, aliased `accel0`:
      upstream's `zephyr,i2c-emul-controller` with the bmi160 upstream's own
      chart sample uses on native_sim. `DESIGN.md` D8j.
- [x] **A pressure sensor**, the bmp581, aliased `pressure-sensor`.
- [x] **The host sets what the sensors read.** `wasm,host-sensor-bridge`
      hands the host's readings to the emulators through the
      emulated-sensor backend API, the call upstream's tests make. The page
      has a Tilt pad, and the Accelerometer build shows the real bmi160
      driver reading gravity move off Z as the board is tilted. Node scripts
      it with `--accel`, and CI checks both.
- [ ] **Triggers and FIFO streaming.** `accel_trig`, `6dof_fifo_stream` and
      `stream_drdy` need a data-ready or FIFO interrupt, and no upstream
      sensor emulator drives an interrupt pin: the bmi160, bma4xx, icm4268x
      and bmp581 emulators have none. The icm4268x emulator, the natural
      `stream0`, has no FIFO either. This is upstream emulator work: an
      emulator that raises its INT line through `gpio_emul` would make all
      three run. It is the next thing to propose there. Raising the pin from
      this board's sensor bridge would not be enough: the bmi160 driver then
      reads `INT_STATUS1` for its data-ready bit, which the emulator never
      sets. And `accel_trig` needs twister's `fixture_sensor_accel_int`, an
      accelerometer with its interrupt wired, so it would not count here
      even then; it is now recorded as filtered for want of the fixture.
- [ ] **The accelerometer chart on the page.** It runs, reads the tilt and
      draws it, but slower than real time: under Node, 3 s of guest time
      take about 10 s, with a first frame that takes several seconds. A
      profile puts 96% of the time in LVGL's `lv_draw_sw_fill`: the chart
      redraws a full-screen background fifty times a second, and a pixel
      loop pays for a safepoint on every iteration. Making leaf pixel loops
      cheap is performance work, which the issue lists as a non-goal. This
      is the first case where it limits what can be shown, so it is worth
      reconsidering here.
- [ ] Optionally, the browser's Generic Sensor API behind the bridge, so a
      phone's own tilt drives the board's accelerometer.

## Phase 6 — networking

- [x] **The loopback spike: the IP stack works.** Zephyr's own network test
      suites need no peer: they run over the loopback interface, or over
      dummy interfaces they define themselves. `scripts/net_tests.json`
      records all 139 suites under `tests/net`, and
      `check_kernel.py --list scripts/net_tests.json` re-runs them.
      **102 pass, 1,144 test cases in all**, with no network code changed.
      That includes:
      - UDP and TCP sockets, `poll`, `select`, `socketpair`, raw and packet
        sockets;
      - IPv4 and IPv6, fragmentation, routing, ARP, ICMP, MLD, IGMP;
      - DHCPv4 and v6, DNS, mDNS, LLMNR;
      - CoAP, MQTT, MQTT-SN, the HTTP server, LwM2M content formats,
        Prometheus.

      One port bug stood in the way. The network stack declares its
      interface list's bounds by hand, under the names every ELF linker
      script defines, and the section generator had defined only the port's
      own names. Nothing that used the stack linked. `DESIGN.md` D6.

      Of the other 37:
      - 17 are refused by Kconfig, every one of them for want of mbedTLS or
        PSA crypto: all the TLS suites, and IPv6, whose privacy extensions
        select PSA. Two more need mbedTLS headers.
      - 4 trap on an indirect call: `conn_mgr_conn`, the LwM2M RD client and
        two PTP suites. D8b is the first suspect; none is diagnosed yet.
      - 4 finish with failures: `icmp`, `virtual`, `rtp/loopback`, zperf.
      - 3 need something else not here: two a full libc they do not ask for
        (`ssize_t`, `strcasecmp`), and one the zcbor module.
      - 1 tests native_sim's offloaded sockets, which exist only there.
      - The last 6 do not finish or do not build for reasons not yet looked
        at. Each has a note in the record.
- [x] **mbedTLS.** Imported as picolibc was: two modules, `mbedtls` and
      `tf-psa-crypto`, at the revisions Zephyr pins. **112 of 139 network
      suites now pass**, ten more than before, among them:
      - TLS sockets, with DTLS handshakes (`socket/tls`, 49 cases);
      - IPv6 (61 cases), whose privacy extensions select PSA;
      - websockets;
      - the CoAP server, the HTTP TLS server, the LwM2M engine and the SSH
        server.

      Four samples pass too, which is the score going from 46 to 50:
      `drivers/crypto`, `psa/its`, `psa/persistent_key` and `subsys/uuid`,
      whose version 5 UUIDs are hashed through PSA.

      The port needed two things, and Zephyr and mbedTLS needed nothing:
      - A TLS handshake suspends from 4,160 bytes of wasm frames, just
        over the 4 KB Asyncify buffer every stack reserves. A build with
        mbedTLS gets 8 KB (`DESIGN.md` D8).
      - mbedTLS builds itself with `-Werror`, and clang 21's
        `-Wuninitialized-const-pointer` fires on a false positive in
        `x509_crt.c`, as it would on any target. The port turns that one
        warning off for that one library, and `upstream/mbedtls/` has the
        fix for mbedTLS.

      Of the 19 suites that waited on mbedTLS, the 9 that still do not pass
      each have another cause:
      - the HTTP/3 server and QUIC trap on an indirect call;
      - LwM2M interop is driven by pytest against a server;
      - OCPP panics, and upstream only builds it;
      - `all` needs an 802.15.4 radio in the devicetree;
      - WireGuard needs an errno picolibc lacks;
      - `wifi/configs` needs the hostap module;
      - one TLS configuration wants an mbedTLS option Zephyr leaves off;
      - one credentials backend has a compile error not yet looked at.
- [x] **The indirect-call traps.** Six suites trapped on "null function or
      function signature mismatch", recorded with D8b as the first suspect.
      Three were D8b and three were not:
      - **The port's own bug:** the ztest thread's 1 KB stack overflowed
        on a test that calls down through conn_mgr, net_if and net_mgmt.
        The overflow zeroed a test's function pointer in the ztest list
        below the stack, and the suite trapped much later. There is no
        guard page to notice, and wasm does not trap on a store inside its
        memory (`DESIGN.md` D8). The board now defaults the ztest stack to
        4 KB. That fixed `conn_mgr_conn` and two PTP suites, and three
        suites recorded with other symptoms: two more PTP suites and
        `virtual`.
      - **Upstream bugs, as patches:** QUIC closes sockets through the
        wrong member of a union, so every close traps (0007, with the same
        bug in CAN sockets as 0008). The LwM2M RD client test calls its
        callbacks through the wrong pointer type (0009). With the patches,
        QUIC passes and so does the RD client. HTTP/3 then gets as far as
        a slab corruption that is not diagnosed.

      **118 of 139 now pass.** Finding them needed two tools the port did
      not have: a way to name a trapping function, and a way to catch a
      store to one address (`DESIGN.md` D8 and D9).
- [x] **Two boards on one page, with a virtual Ethernet between them.**
      A small driver, `wasm,host-ethernet`, sends each frame to the host,
      and the host hands it to the other board: on the page another
      Worker, in Node another `Host` in the same process (`run.mjs
      --peer`). The link is off unless a build asks for it with the
      `wasm-ethernet` snippet, so no other build changes. `DESIGN.md` D8k.
      - The first pair is upstream's `echo_client` and `echo_service`, as
        shipped. The client echoes TCP over IPv4 and IPv6, and UDP at its
        own pace of one packet every 150 ms. TCP runs at about 750 packets a
        second on each IP version in Node, and about 160 on the page, where
        each frame travels from one Worker through the page to the other.
      - Both boards have the network shell, so `net ping` from one to the
        other works, and so does `net iface`.
      - The page shows both terminals, labelled, and counts the frames each
        way. Pause and step are hidden for a pair, since stepping one board
        would leave its peer's clock behind.
      - Checks: the Node check requires 1,000 TCP echoes each way on
        both IP versions. The browser check does the same through the page,
        typing into the server's terminal, and requires Stop to end both
        boards.
      - The link was real-time at first: each board followed the wall
        clock, and a run was not byte-for-byte repeatable. Lockstep time,
        below, replaced it.
      - `echo_server`, the obvious server, traps on D8b. Patch 0010 in
        `upstream/zephyr/` fixes it.

      Two port bugs came out of building the pair. The section generator
      lost one of two same-named members of one archive
      (`libsubsys__net.a` has two `sockets.c.obj`), and the link check
      caught it. The same bug had been failing `tests/net/pmtu`'s build,
      recorded as not diagnosed; it now passes, and 119 of 139 network
      suites pass. The driver's first `get_capabilities` had an older
      signature, and the compiler caught that, where wasm would have trapped
      at run time.
- [x] **Seven more pairs**, which raised the score from 52 to 61. They sit
      under "Two boards" in the page's menu.
      - **Echo, as shipped:** `echo_client` against `echo_async`,
        `echo_async_select` and the one-at-a-time `echo`. TCP only. Each
        server prints an empty address for its IPv6 client, from a buffer
        too small for one; patch 0011 fixes that, after which `echo-one`
        can expect the client's address.
      - **CoAP**, with the client's addresses set (see "The measure"):
        `coap_server` with `coap_client`, with `coap_upload` and with
        `coap_download`. The first runs GET, PUT, POST, DELETE, a 2 KB
        blockwise GET and an observed counter; the other two move 2 KB in
        64-byte blocks.
      - **HTTP:** `http_client` against `http_server`, which listens on the
        port the client has built in. GET and POST, over IPv4 and IPv6.
        The GETs succeed. The POSTs come back 404 or 405, since the client
        was written for a test server on a Linux host (net-tools'
        `http-server.py`) and its paths are fixed in its source, so no
        address can fix it.

      Two things the pairs needed from the host:
      - A client powered on two seconds after its server
        (`start_after_ms`). `coap_client` and `http_client` send once and
        give up, so they have to find the server already listening, and
        so does `echo_client`, which gives up on a refused connection. It
        found its server ready by luck of load until a browser check run
        in September did not. Until
        then, frames sent towards the client are dropped, as on a cable
        plugged into nothing.
      - One status line, "Built with: ...", under the hint for each pair set
        up differently from how upstream ships it.

      Left out, each for a reason:
      - `dns_resolve` with `mdns_responder`: the network shell calls
        `strcasecmp`, which the minimal libc lacks. Fixing that means
        choosing a libc, which is more than an address. It runs now:
        below, "The mDNS pair".
      - `echo_server`: needs patch 0010.

      Upstream's CoAP client library reports `-ECANCELED` for a request
      that has already finished, when the sample cancels right after its
      last callback. The upload and download samples print it as an error
      after "done". It does not affect the transfer. The race is
      upstream's, and it is recorded here rather than chased.
- [x] **Per-board input, and zperf.** Scripted input now reaches either
      board of a pair: `ci_stdin` on the second board goes through
      `run.mjs --peer-stdin` in Node and is typed into its own terminal in
      the browser check. That was all zperf needed. Its two ends are the
      same sample, the client with its addresses swapped. The server's
      shell starts UDP and TCP receivers, and the client's uploads for two
      seconds each way: 52 UDP packets at 50 kbit/s with none lost, and a
      TCP stream. The score went from 61 to 62.

      zperf's upload suspends from deep in the shell thread, below a
      command handler, the shell and the socket layer. That is 4,240 bytes
      of unwound frames, more than the default Asyncify buffer holds, so a
      build with zperf gets the larger buffer mbedTLS already gets
      (`DESIGN.md` D8).

      The throughput it reports is that of two paced virtual boards in one
      process, and of TCP especially it says nothing about a real link:
      tens of megabits a second, because the stack's copying takes no
      guest time.
- [x] **Lockstep time.** The two boards of a pair now run on one clock
      (`host/pair.mjs`, `DESIGN.md` D8k):
      - frames carry the time they arrive, 100 µs after they were sent;
      - the board that is behind runs, as far as the other could still
        reach it;
      - the second board powers on at a stated guest time.

      A pair is now as repeatable as a single board, and `check_site`
      runs every pair twice and requires both boards' output to match.
      It was also faster: the echo pair did 32,000 exchanges in the
      guest time the wall-clock link managed 10,000, and all nine pairs
      check in about a minute. On the page both boards run in one Worker,
      paced together.

      The first version stalled every exchange by about 10 ms. The limit
      a running board was given assumed the other board would sleep until
      its own next event, but a frame the running board sent could wake it
      sooner. Sending a frame now pulls the sender's limit in to that
      frame's arrival.
- [x] **The mDNS pair**, which raised the score from 62 to 64.
      `dns_resolve` asks the link who `zephyr.local` is, over IPv4 and IPv6
      multicast, and `mdns_responder` answers with 192.0.2.1 and
      2001:db8::1. The client is given the other addresses of the two.
      Both boards have the shell, and `net dns zephyr.local` on the client
      asks again.

      What stopped it was the C library, not the network. The network
      shell calls `strcasecmp`, which the minimal libc lacks, and the board
      forced the minimal libc, a choice upstream makes for no board by
      default. The board now takes Zephyr's default, picolibc, and every
      record was re-measured against it (`DESIGN.md` D11):
      - samples: nothing got worse, and three more build (above, "The
        measure"). `smf_calculator` needed one more compiler helper,
        `__extenddftf2`, for picolibc's `strtod`;
      - kernel suites: all 25 as recorded;
      - network suites: six more pass, **125 of 139**. `coap_client` and
        `http_client` had stopped on `ssize_t` and `strcasecmp`, `wireguard`
        on `EKEYEXPIRED`, and `mcp` and the two Wi-Fi credential backends
        on causes not diagnosed then that went with the minimal libc.

      `upstream/zephyr/0012` adds `strcasecmp` to the minimal libc anyway,
      for the boards that do choose it.
- [x] **A real network, through a relay** (`DESIGN.md` D8l), which raised
      the score from 64 to 65. The board's frames go over a WebSocket to a
      relay that speaks v86's `wsproxy` protocol, one frame per message,
      and the relay makes real connections for it.
      - **Why a relay.** A tab cannot open raw sockets. Port tunnels such
        as wstunnel carry streams, not frames, so they would still need a
        stack. v86's relays already exist and need nothing written or
        hosted here.
      - **Which relay.** RootlessRelay needs neither root nor TAP:
        `ENABLE_WSS=false npx rootlessrelay`. `run.mjs --uplink
        ws://127.0.0.1:8086/` and the page's Uplink field both take its
        URL.
      - **What runs.** `dhcpv4_client`, as shipped, gets a lease and from
        its shell pings the gateway and resolves real names. CI starts the
        relay, pinned, on loopback, and checks the lease in Node and in
        Chromium.
      - **Samples with static addresses.** Most ship with `192.0.2.1`,
        gateway and DNS `192.0.2.2`, which RootlessRelay could not serve:
        its pool was fixed at `10.0.2.x`, and it sent DNS for the gateway
        out to the internet. `upstream/rootlessrelay/0001` fixes both, and
        with it `sockets/http_get` fetched `http://google.com`, unmodified,
        from Node. They go on the page once the fix is taken.
      - **Off by default.** The page names no relay. Choosing a public one
        for visitors, as zephyr-v86 did, is for whoever publishes the site.

      Drawn from v86's networking notes, beriberikix/zephyr-v86 (wsproxy
      and RootlessRelay under `native_sim`) and
      kartben/zephyr-in-the-browser (the `192.0.2.x` addressing, and an
      opt-in bridge).
- [ ] **Inbound through the relay.** RootlessRelay's reverse proxy may
      reach a board's server (`dumb_http_server`); not tried yet.
- [x] **The host as the LAN** (`DESIGN.md` D8m), which raised the score
      from 65 to 69. The host is the network a single board is plugged
      into: lwIP at `192.0.2.2`, from tcpip.js's wasm, driven by our own
      glue on the board's virtual clock. It offers:
      - DHCP;
      - DNS, answering every name with itself;
      - SNTP, TFTP and HTTP;
      - dialling a board's port, for samples that are servers.

      Nothing leaves the page, and runs are repeatable. `check_site` runs
      each twice. New builds: `http_get`, `dumb_http_server`,
      `tftp_client` and `sntp_client`. `dhcpv4_client` now gets its lease
      from the LAN, and from a relay when the page is given one.

      Testing it found a bug in tcpip.js's C glue: a frame built from
      chained buffers was handed over as its first buffer, so it went out
      with a bad checksum and the connection stopped. `Lan.frameAt`
      follows the chain from JavaScript. `scripts/check_lan.mjs` puts
      4 MB through an echo and checks every checksum, and it fails
      without the fix. The report is in `upstream/README.md`.

      The idea is kartben/zephyr-in-the-browser's, whose page is its LAN.
      That repository has no licence, so only the idea is used.
- [x] **More services on the LAN**, which raised the score from 72 to 77.
      The LAN now also offers:
      - a WebSocket echo, which needs a synchronous SHA-1 for its
        handshake;
      - CoAP over TCP;
      - FTP, passive mode, with a tree that can be written to;
      - pings to the board, and dials that ask for a path.

      What it does shows on the page as `[lan …]` lines, and `lan_expect`
      checks them for samples whose own output cannot say. The Ethernet
      driver now claims promiscuous mode and VLANs, both of which it
      already did by doing nothing. New builds: `ftp_client`, typed into;
      `prometheus`, asked for `/metrics`; `promiscuous_mode` and
      `pkt_filter`, pinged; and `vlan`.

      Two samples these were written for do not count yet, and each was
      checked against the LAN with its fix. `websocket_client` fails its
      own handshake at this pin, because the library selects SHA-256
      where it hashes with SHA-1. Upstream has fixed that, and 60
      round trips then pass. `coap_client_tcp` takes a request sent in
      the first millisecond of uptime for one never sent, and waits for
      ever. With `upstream/zephyr/0013` it runs to "Sample complete".
      `dumb_http_server_mt` traps on its thread entries (0014).
      `scripts/check_lan.mjs` covers each service.
- [ ] **Pairs across tabs or machines**, through one relay:
      RootlessRelay lets its VMs reach each other.

The sweep counts samples, and networking's samples are nearly all `net`
harness: they need a peer, which twister never gives them. The virtual L2
gives them one, and a pair on the page counts both its samples, as blinky
counts, by the demo's checks.

## Phase 7 — Bluetooth

As the issue has it, with one dependency it does not name: Zephyr's H4 driver
wants an interrupt-driven UART, and this port's UART was polled.

- [x] **An interrupt-driven UART** (`DESIGN.md` D10), on line 5. Typed
      bytes come down its wire at 115200 baud and the host raises it for
      each; the driver keeps a byte of look-ahead and
      raises the line itself while its transmitter is enabled, since the
      host empties it at once. Every shell now runs interrupt-driven, as on
      a real board. `drivers/uart/echo_bot` runs on the page, which types
      into it, and counts as `basic/button` does: upstream's harness for it
      is a keyboard, which twister cannot drive.
- [x] **A controller for H4** (`DESIGN.md` D8p). Each board of a pair has
      a second UART with upstream's H4 driver on it, and the host emulates
      the controller at its far end, with a radio between the two on the
      pair's clock. Zephyr's own Bluetooth host advertises, scans, connects
      and runs GATT over it, unmodified. `peripheral_hr` and `central_hr`
      connect and stream heart-rate notifications, and `observer` hears
      `beacon`: four samples, which count as the other pairs do, since
      upstream's `bluetooth` harness is one twister cannot run.
- [x] **Encryption in the controller** (`DESIGN.md` D8p): LE Start
      Encryption, the LTK request and reply, and Encryption Change or Key
      Refresh on both sides. `central_gatt_write` and
      `peripheral_gatt_write` pair with Secure Connections, encrypt the link
      at level 2 and stream writes over it.
- [ ] **More than one connection per controller**, for
      `central_multilink` and a peripheral that is also a central.
- [ ] **Web Serial to a real HCI dongle**, behind the same UART.

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
      - the arch provides the 128-bit helpers clang calls and nothing
        here supplied (`__multi3`, `__ashlti3`, `__lshrti3`, and since the
        mDNS pair `__extenddftf2`), because there is no compiler-rt for
        wasm32;
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
        library, which this toolchain did not have for wasm32 (now the
        sysroot's, D13; `cpp/hello_world` passes);
      - `logging/syst` needs the mipi-sys-t module, and then
        `__builtin_return_address`, which clang does not implement for wasm;
      - `cmsis_dsp` needs its module;
      - POSIX `eventfd` stops at the link on `_net_if_list_start`;
      - the ztest benchmark wants per-architecture assembly.
- [x] **A C++ standard library.** `scripts/build_sysroot.sh` builds what
      the Zephyr SDK provides elsewhere: picolibc, libc++, libc++abi and
      compiler-rt's builtins for wasm32, from the module's picolibc and the
      LLVM release CI's clang comes from (DESIGN.md D13). A build that sets
      `REQUIRES_FULL_LIBCPP` uses it, and nothing else does. `cpp/hello_world`
      prints through `std::cout` and passes. It needed one picolibc patch,
      six `long double` sources its CMake build left out. With it, the
      optional `tflite-micro` and `chre` modules are imported and both
      samples pass.
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
      the series the score would be ten higher, 74. It stays 64 until Zephyr
      takes the patches and the pin moves, because "unmodified" means
      upstream's tree.

## Lessons

The issue asks two things: how much of Zephyr runs in a tab, and whether that
is a good way to learn it. The score answers the first, and has gone from 3
to 64. Nothing yet answers the second. The page now teaches with one
sample, and nobody learning Zephyr has tried it yet.

- [x] **Which thread is waiting on what** (Phase 2's open item) came first,
      because "waiting for a fork that Philosopher 2 holds" is the lesson.
- [x] **One lesson**, to find out what a lesson needs. `philosophers`, six
      threads contending for six forks, which is what pause, step, step back
      and the thread table were built to show. It takes six steps:
      1. run it;
      2. pause;
      3. step one context switch at a time, and see which priority wins;
      4. find a waiting philosopher, who holds its fork, and priority
         inheritance;
      5. why it never deadlocks, which is Dijkstra's ordering: everyone
         takes the lower-numbered fork first;
      6. step back through a fork changing hands.

      A lesson turned out to need very little: a `lesson` list on a build's
      `apps.json` entry, which the page shows as a panel with Previous and
      Next, and the thread table saying what each thread waits for. So the
      next lesson is an entry, not code. The steps are text and nothing
      checks that a person followed them. The browser check follows them
      itself, so a change that breaks what the lesson describes fails CI.
      What a lesson needs beyond this is for its audience to say. Nobody
      learning Zephyr has tried it yet.

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
after four phases, 50 samples, three file systems, LVGL and mbedTLS there are still
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
