# zephyr-wasm

Zephyr with WebAssembly as a real architecture.

**[Try it in your browser](https://beriberikix.github.io/zephyr-wasm-soc/)** —
boot the kernel, run its test suite, or type into the Zephyr shell. Nothing to
install.

This is not native_sim built with a Wasm toolchain. The kernel runs
freestanding in a single `wasm32` linear memory, using Zephyr's own
scheduler and its default C library, picolibc, built from source. The host plays the part of a SoC: instead of memory-mapped
registers it provides a handful of imported functions, and it owns the clock.

Context switching runs on Binaryen's Asyncify. Interrupts are cooperative: the
host sets a pending word in linear memory and the kernel notices it at a
safepoint. By default the clock is virtual, so a run does not depend on how
fast the machine underneath it is, and two runs produce identical output.

`DESIGN.md` records the decisions and the host ABI. `NOTES.md` is the running
log, including what did not work. `BRIEF.md` is the original task.

## What works

* `samples/hello_world` boots and exits cleanly.
* `samples/synchronization` alternates two threads with `k_msleep` honoured.
* `samples/philosophers` runs, which is six threads, mutexes and sleeps.
* `samples/subsys/logging/logger` runs, hexdumps and all.
* `samples/basic/sys_heap` runs, which is the heap.
* `samples/basic/blinky` and `samples/basic/button` run, with the LEDs drawn
  on the page and buttons to press. The pins are Zephyr's own emulated GPIO
  controller, so the driver and subsystem code above them is the real thing.
* `tests/drivers/entropy/api` passes, on a generator that is seeded by
  default so that runs stay reproducible.
* 17 of Zephyr's own kernel test suites pass outright, 450 cases in all.
  `scripts/kernel_tests.json` records every suite tried, including the eight
  that do not pass and why.
* Two runs in virtual time produce byte-identical output.
* Two equal-priority threads that never yield are time-sliced against each
  other, through safepoints inserted after linking.
* `samples/subsys/shell/shell_module` runs interactively over a polled UART.
* Flash and EEPROM, as upstream's simulators, with NVS, ZMS and settings on
  top. `sys_reboot()` is a warm reboot that keeps the flash, and the flash
  survives the run too: in a file under Node, in IndexedDB in a browser.
  `samples/subsys/kvss/nvs` on the page counts its reboots in flash and
  still finds what it stored after the page is reloaded.
* File systems: FAT and ext2 on a RAM disk, and littlefs on the flash, so
  it persists as the flash does.
* A display drawn on the page, and touch and keys into the input subsystem.
  LVGL runs unmodified: all seven of its demo entries pass, and the widgets
  demo on the page responds to touch.
* Picolibc, Zephyr's default C library, for every build, and C++ static
  constructors. The POSIX `env`, `uname` and `philosophers` samples run
  unmodified on it.
* Sensors: an accelerometer and a pressure sensor, upstream's emulated
  chips on upstream's emulated I2C bus, read by the real drivers. The page
  has a Tilt pad that sets what the accelerometer reads, and
  `samples/sensor/accel_polling` shows gravity move as the board is tilted.
* Networking: Zephyr's IP stack over loopback, sockets included. 125 of the
  139 network test suites pass: UDP, TCP, TLS and DTLS, IPv4, IPv6, DHCP,
  DNS, CoAP, MQTT, websockets, the HTTP server and more.
  `scripts/net_tests.json` records every suite.
* mbedTLS and PSA crypto, from the modules Zephyr pins, unchanged.
* Two boards on one page, joined by a virtual Ethernet, in ten pairs of
  upstream samples: `echo_client` against four echo servers, CoAP's server
  against its three clients, HTTP's client and server, zperf against
  itself, typed into on both boards, and `dns_resolve` finding
  `mdns_responder` by name. The echo pairs run as shipped; the
  others have only their addresses and ports set, and the page says which.
  The two boards run on one clock, so a pair gives the same output every
  run. `run.mjs --peer` does the same in Node, and `--peer-stdin` types
  into the second board.
* The host's own network: lwIP at `192.0.2.2`, on the board's clock, plays
  the Linux host upstream's networking samples expect. It offers DHCP, DNS,
  SNTP, TFTP, HTTP, a WebSocket echo, CoAP over TCP, FTP, an MQTT broker
  and an MQTT-SN gateway, and can ping
  the board or ask a server on it for a page. `http_get`,
  `dumb_http_server`, `tftp_client`, `sntp_client`, `ftp_client`,
  `prometheus`, `mqtt_publisher`, `promiscuous_mode`, `pkt_filter` and
  `vlan` run on it
  unmodified, with nothing leaving the page and the same output every
  run; what the network did shows as lines stamped `[lan <guest time>]`. `run.mjs --lan` in
  Node.
* A real network, through a relay you run: the board's Ethernet frames go
  over a WebSocket to any relay that speaks v86's wsproxy protocol, and
  `dhcpv4_client` gets a real lease. See "A real network" below.
* 47 upstream samples pass their own twister criterion, unmodified, out of
  the 102 that twister itself would run on this board. Among them the
  meta-IRQ dispatcher, condition variables, message queues, RTIO, two zbus
  samples, both CMSIS-RTOS v2 samples and the hierarchical state machine,
  which is on the page as something to type events into.
  `scripts/samples.json` records every candidate tried, with a cause for each
  one that does not pass.

Not done: twister builds for this board but cannot find the module's SoC. It
takes a `--board-root` and no `--soc-root`, relying on module discovery, and
discovery finds nothing because this module is the manifest repository rather
than a project inside it. `NOTES.md` has the detail.

## How preemption works

Nothing preempts a running wasm function, so `CONFIG_WASM_SAFEPOINTS` inserts
a call at the top of every loop body after linking, and a pending interrupt is
taken there. It runs before Asyncify, so those calls can suspend: taking an
interrupt may switch threads.

It needs a second piece. Under virtual time the clock only moves when the
kernel idles, so a thread that spins without calling the kernel would freeze
it, and a frozen clock means the timer never fires. Every
`CONFIG_WASM_SAFEPOINTS_PER_TICK` safepoints the guest gives the host a chance
to advance time.

The cost, on 800 million iterations of a tight arithmetic loop, which is the
worst case by construction:

| | Without | With | Ratio |
|---|---|---|---|
| Code size | 329686 | 337175 | 1.023x |
| Wall time | 1.74 s | 3.83 s | 2.28x |

The acceptance suite shows no perceptible change.

## Requirements

| Tool | Version used | Notes |
|---|---|---|
| clang | 23.1.1 | needs the wasm32 target; CI uses 21 |
| wasm-ld | 23.1.1 | must match clang; Homebrew ships it in the separate `lld` formula |
| wasm-opt | 132 | Binaryen |
| wasm-objdump | 1.0.42 | wabt |
| Node.js | 26 | 20 or newer should do |
| Python | 3.12 | Zephyr's own `west build` needs 3.12 or newer |
| west, cmake, ninja | | with Zephyr's Python dependencies |

**Version matters more than it should.** On clang 18 the linker leaves the
iterable-section bounds undefined and ztest will not link, so the section
scheme quietly stops working while simpler applications still build. 21 and 23
are known good; the true minimum is not established.

On macOS:

```sh
brew install llvm lld binaryen wabt node
brew link --overwrite wabt          # binaryen owns the wasm2c name
```

Both LLVM formulas are keg-only, so `tools.env` carries their paths. Adjust it
if your toolchain lives elsewhere.

## Setting up

```sh
git clone <this repo> zephyr-wasm
west init -l zephyr-wasm
west update
zephyr-wasm/scripts/apply_patches.sh
zephyr-wasm/scripts/build_sysroot.sh    # only for samples that need a full C++ library
```

`west update` also fetches the modules the samples here use, and nothing
else: FatFs and littlefs, LVGL, picolibc, mbedTLS and its PSA crypto,
CMSIS-DSP, nanopb, SyS-T, and two of Zephyr's optional modules, TensorFlow
Lite Micro and CHRE. `west.yml` imports them from Zephyr's manifest by
name. nanopb generates C from `.proto` files as it builds, which needs
`pip install grpcio-tools` alongside Zephyr's own Python requirements.

`build_sysroot.sh` builds picolibc, libc++, libc++abi and compiler-rt's
builtins for wasm32 into `wasm-sysroot/` beside the workspace, which is what
a sample with `CONFIG_REQUIRES_FULL_LIBCPP` needs (`DESIGN.md` D13). It uses
the clang in `/usr/lib/llvm-21` unless `WASM_LLVM_PATH` names another, and
downloads the matching LLVM source unless `LLVM_TARBALL` names a copy. It does
nothing if the sysroot is already built from the same sources. Everything
else builds without it.

The Zephyr tree is otherwise read-only. Nine patches are needed and each is
explained in `patches/README.md`; most of them are the same underlying
gap, which is that several places in Zephyr assume an architecture is in-tree
or assume a linker script exists. One more, under `patches/picolibc/`, is to
picolibc, and so is a second, which only the sysroot needs.

## Building and running

`scripts/build.sh` wraps `west build` with the flags this module needs on
every build, because Zephyr looks for a toolchain under `TOOLCHAIN_ROOT`
rather than through the module system.

```sh
zephyr-wasm/scripts/build.sh build-hello zephyr/samples/hello_world
node zephyr-wasm/host/run.mjs build-hello/zephyr/zephyr.wasm
```

```
*** Booting Zephyr OS build e201b84b04e4 ***
Hello World! wasm_node/node
```

Two threads alternating, with sleeps honoured:

```sh
zephyr-wasm/scripts/build.sh build-sync zephyr/samples/synchronization
node zephyr-wasm/host/run.mjs --max-time 2000 build-sync/zephyr/zephyr.wasm
```

```
*** Booting Zephyr OS build e201b84b04e4 ***
thread_a: Hello World from cpu 0 on wasm_node!
thread_b: Hello World from cpu 0 on wasm_node!
thread_a: Hello World from cpu 0 on wasm_node!
```

The kernel test suite:

```sh
zephyr-wasm/scripts/build.sh build-sem zephyr/tests/kernel/semaphore/semaphore
node zephyr-wasm/host/run.mjs --max-time 60000 build-sem/zephyr/zephyr.wasm
```

```
Running TESTSUITE semaphore
 PASS - test_k_sem_define in 0.000 seconds
 ...
PROJECT EXECUTION SUCCESSFUL
```

The shell, interactively. `--interactive` forwards this terminal's input to
the guest UART and keeps the run alive while the guest is idle:

```sh
zephyr-wasm/scripts/build.sh build-shell zephyr/samples/subsys/shell/shell_module
node zephyr-wasm/host/run.mjs --interactive --max-time 600000 build-shell/zephyr/zephyr.wasm
```

```
uart:~$ kernel version
Zephyr version 4.4.99
uart:~$ demo ping
pong
```

Ctrl-C exits. Commands can also be piped in, which is how the run above was
checked.

Preemption, which is what safepoints are for. Two threads at equal priority,
both spinning with no kernel calls and no way out:

```sh
zephyr-wasm/scripts/build.sh build-slice zephyr-wasm/tests/timeslice
node zephyr-wasm/host/run.mjs --max-time 30000 build-slice/zephyr/zephyr.wasm
```

```
main: a=50499611 b=49519850
PASS: both threads ran, so preemption works
```

The exact counts move with the binary; what matters is that both are large and
roughly equal. Within one binary they are reproducible, like everything else
under virtual time.

Build the same test with `-DCONFIG_WASM_SAFEPOINTS=n` and it hangs after its
first line, which is the control.

Determinism, which is the point of virtual time:

```sh
zephyr-wasm/scripts/check_determinism.sh build-sem/zephyr/zephyr.wasm --max-time 60000
```

```
deterministic: two runs produced identical output (143 lines)
```

`west build -t run` also works and does the same thing:

```sh
zephyr-wasm/scripts/build.sh build-hello zephyr/samples/hello_world
ninja -C build-hello run
```

## In a browser

The same module runs in Chrome. The guest lives in a Worker, because the
driver loop blocks its thread between suspensions and would otherwise freeze
the tab; output and keystrokes cross by message.

The published copy is at
<https://beriberikix.github.io/zephyr-wasm-soc/>, built by CI from a bare
runner. To do the same locally:

```sh
zephyr-wasm/scripts/stage_site.sh      # builds the demo applications into _site/
zephyr-wasm/scripts/serve_web.sh 8777  # then open http://127.0.0.1:8777/
```

Pick a build and press Run. Under the controls, each build says in one line
what it does or what to do: hold a button, type into the output, touch the
display. The output is a real terminal, xterm.js (vendored in
`host/web/vendor/`), so the shell's line editing, history, Tab completion and
Ctrl+C work as they do on a board's serial console, and samples that draw
with cursor addressing, like the philosophers, draw in place. The page shows
only what the build has: the LEDs and buttons, the
display, Erase flash for a build that uses flash, and a speed control for
the builds that run on their own in real time, which does not change what
they do. A build that waits for a person runs on the real clock, so its
timestamps are the ones you lived through. Choosing another build stops the
one running and clears what it left. The
kernel's thread table is shown underneath: who exists, who holds the CPU,
and what the rest are waiting for, which is a mutex and who holds it, or how
long until they wake. Pause stops the guest between two context switches
and Step lets exactly one through. The philosophers come with a lesson, six
steps in a panel above the output: pause, step, find a philosopher waiting
for a fork and the one holding it, and see why the sample never deadlocks. A server is needed because `file://`
blocks both Workers and `fetch`; this one is bound to the loopback address.
`stage_site.sh` is what CI runs too, so what you see locally is what is
published.

`scripts/check_browser.mjs` runs every build in Chromium the way a person
would: real key presses into the terminal, the mouse held on a button, a drag
across the display. It checks what the screen shows as well as what was
printed: a typo corrected with Backspace, a command recalled with the up
arrow, the philosophers' table redrawn in place, LED 0 lit only while
Button 0 is held.

### A real network

A tab cannot open raw sockets, so a board reaches a real network through a
relay on your machine. Any relay written for v86 works, since the board's
frames go over a WebSocket one per message, which is v86's wsproxy
protocol. RootlessRelay needs neither root nor a TAP device:

```sh
ENABLE_WSS=false npx rootlessrelay            # listens on ws://127.0.0.1:8086/
node zephyr-wasm/host/run.mjs --uplink ws://127.0.0.1:8086/ --interactive \
    build-dhcp/zephyr/zephyr.wasm             # built with -DSNIPPET=wasm-ethernet
```

On the page, choose "DHCP client on a real network", put the same URL in
Uplink and press Run. It is empty until you fill it, and the page names no
relay of its own. Chrome may ask before letting the site reach your
machine. The board gets `10.0.2.15`; `net ping 10.0.2.2` and `net dns
zephyrproject.org` in its shell go through the relay. An uplinked board
follows the wall clock, so unlike everything else here its runs are not
repeatable.

Most network samples ship with a static `192.0.2.1`, gateway and DNS
`192.0.2.2`. RootlessRelay serves those once it has
`upstream/rootlessrelay/0001`, with `GATEWAY_IP=192.0.2.2 DHCP_START=1
DHCP_END=1`. `DESIGN.md` D8l has the rest.

This says nothing new about engine neutrality, because Chrome is V8, the same
engine as Node. That claim rests on the wasmtime result below. What the
browser shows is that the harness is portable to somewhere with no
filesystem, no stdio and no blocking main thread.

## A second engine

`host/run.mjs` runs on Node, which is V8. `host/run_wasmtime.py` implements
the same ABI and the same driver loop against wasmtime, to show that neither
the port nor its determinism depends on one engine:

```sh
python3 -m venv /tmp/wtenv && /tmp/wtenv/bin/pip install wasmtime
/tmp/wtenv/bin/python zephyr-wasm/host/run_wasmtime.py --max-time 60000 \
    build-sem/zephyr/zephyr.wasm
```

It produces byte-identical output to the Node harness, including all 143 lines
of the ztest run. It is not interactive: no UART input, no tracing.

Between them the three hosts cover two engines and three environments: V8
under Node, V8 in a browser with no filesystem and no stdio, and Cranelift
under wasmtime. The kernel is the same module in all three.

## Host options

`host/run.mjs` takes the module and:

| Flag | Effect |
|---|---|
| `--realtime` | follow the wall clock instead of virtual time |
| `--paced` | let virtual time pass at the rate it claims, so a sample that blinks once a second can be watched. The guest sees the same clock either way, so the output is unchanged |
| `--time-scale <n>` | with `--paced`, divide the waiting: 10 is ten times faster than real, 0.1 is slow motion |
| `--threads` | print the kernel's thread table to stderr as it changes |
| `--trace-gpio` | log every GPIO output change to stderr |
| `--gpio <ms>:<pin>=<0\|1>` | move an input pin at a given guest time, repeatable |
| `--trace-switches` | log every context switch and idle to stderr |
| `--max-time <ms>` | give up after this much guest time, default 10000 |
| `--interactive` | forward this terminal's input to the guest UART, and keep running while the guest is idle |
| `--screenshot <file>` | write the display's last frame as a binary PPM. `host/run_wasmtime.py` takes it too |
| `--touch <ms>:<x>,<y>` | touch the display at a guest time and release 50 ms later, repeatable; display pixels |
| `--key <ms>:<code>` | press and release a key (a Zephyr `INPUT_KEY_*` code) at a guest time, repeatable |
| `--flash <file>` | keep the simulated flash in this file: loaded before boot if it exists, written back on reboot and at the end. Without it the flash starts erased every run. `host/run_wasmtime.py` takes the same option |
| `--peer <wasm>` | run a second board linked to this one by Ethernet, on one clock; `--peer-out`, `--peer-delay` and `--peer-stdin` go with it |
| `--uplink <ws-url>` | link the board's Ethernet to a real network through a wsproxy relay (see "A real network"). Implies `--paced` |
| `--lan` | plug the board into the host's own network: lwIP at 192.0.2.2 with DHCP, DNS, SNTP, TFTP, HTTP, WebSocket, CoAP over TCP, FTP, MQTT and MQTT-SN, on the board's clock (`DESIGN.md` D8m) |
| `--lan-dial <ms>:<port>[:<path>]` | with `--lan`, connect to the board's port at a guest time and ask for the path, `/` unless given, for a sample that is a server |
| `--lan-ping <ms>` | with `--lan`, ping the board at a guest time; the replies, or their absence, are in its `[lan …]` lines |

## Continuous integration

`.github/workflows/pages.yml` starts from a bare Ubuntu runner, installs the
toolchain, clones Zephyr, applies the patches, builds the wasm32 sysroot (or
restores it from the cache), builds everything
`scripts/apps.json` names, runs each one and checks it printed what that file
says it should, checks two runs are byte-identical, runs the page itself in
Chromium, and only then publishes. It is the reproducibility check for
everything above: if it is green, these instructions work on a machine that is
not the author's.

To run those checks locally against a staged site:

```sh
node zephyr-wasm/scripts/check_site.mjs        # every build, under Node
node zephyr-wasm/scripts/check_browser.mjs     # every build, in Chromium
zephyr-wasm/scripts/check_engines.sh _site/m/sem.wasm --max-time 60000
python3 zephyr-wasm/scripts/check_kernel.py    # Zephyr's kernel suites
python3 zephyr-wasm/scripts/check_samples.py --recorded passes  # upstream samples
```

`check_samples.py` builds each upstream sample entry the way twister would and
judges it by the entry's own `harness_config`. An entry whose twister
`filter:` is false on this board is recorded as filtered, not failed; that is
evaluated with twister's own parser, which needs `pip install ply`. It
compares against `scripts/samples.json` and exits non-zero on anything that
did worse. `--match samples/kernel` narrows it to one area; `--discover`
regenerates the candidate list from upstream's `tests.yaml` files. All 230
candidates take a few hours, so CI runs them weekly in
`.github/workflows/samples.yml` rather than on every push.

The browser check needs Playwright (`npm install --no-save playwright && npx
playwright install chromium`); nothing else here does, which is why it is not
a dependency of the repository.

## Layout

```
arch/wasm/            the architecture: switching, interrupts, idle, fatal
include/zephyr/arch/wasm/   its headers, including the zephyr_host ABI
soc/wasm/             the host as a SoC
boards/wasm/wasm_node/      the board
drivers/              console and system timer over host imports
cmake/                toolchain variant, and the build steps Zephyr lacks
scripts/              offsets and section generators, build and check scripts
scripts/apps.json     the applications the demo is built from, and what each
                      one must print; the single source for the page's menu,
                      the staged manifest and what CI asserts
scripts/kernel_tests.json  how each Zephyr kernel suite does here, and why
host/core.mjs         the engine-neutral driver loop and host ABI
host/run.mjs          the Node front-end
host/run_wasmtime.py  a separate implementation, for wasmtime
host/web/             the browser front-end: a page and a Worker
spikes/               the Milestone 0 experiments, each with a run.sh
tests/two_threads/    a minimal two-thread reproducer
tests/timeslice/      two spinners that only run if preemption works
tests/safepoint_cost/ fixed compute, for measuring what safepoints cost
patches/              the seven Zephyr changes and one to picolibc, each explained
upstream/             fixes proposed to Zephyr itself, not applied here
.github/workflows/    builds from scratch and publishes the demo
```

## Licence

Apache-2.0, matching Zephyr. See `LICENSE`. The files under `patches/` are
diffs against Zephyr and carry Zephyr's licence, which is the same.

## Where this is going

[Issue #1](https://github.com/beriberikix/zephyr-wasm-soc/issues/1) sets out
the vision: how much of Zephyr can run in a browser tab, as a way to learn it.
`ROADMAP.md` is the plan underneath it, including the order the work is done in
and what the issue did not account for.

Progress is measured in upstream Zephyr samples that pass their own
acceptance criterion unmodified, which is 92 today. `scripts/apps.py score`
is what counts it, from the samples sweep.

## Feedback

The interesting parts to argue with are `patches/README.md`, which explains
each change to Zephyr and why, `DESIGN.md`, which records the decisions and
what they cost, and `ROADMAP.md`, which says where this is going and what the
vision issue did not account for. None of them needs a build to read.
