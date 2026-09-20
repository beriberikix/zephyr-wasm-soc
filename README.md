# zephyr-wasm

Zephyr with WebAssembly as a real architecture.

This is not native_sim built with a Wasm toolchain. The kernel runs
freestanding in a single `wasm32` linear memory, using Zephyr's own libc and
scheduler. The host plays the part of a SoC: instead of memory-mapped
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
* `tests/kernel/semaphore/semaphore` passes all 32 tests under ztest.
* Two runs in virtual time produce byte-identical output.

Milestone 3 of the brief, which covers preemption through safepoint
instrumentation, is not done. Without it a thread that never yields cannot be
interrupted, so time slicing does not work and a runaway guest has to be
stopped from outside.

## Requirements

| Tool | Version used | Notes |
|---|---|---|
| clang | 23.1.1 | needs the wasm32 target |
| wasm-ld | 23.1.1 | Homebrew ships this in the separate `lld` formula |
| wasm-opt | 132 | Binaryen |
| wasm-objdump | 1.0.42 | wabt |
| Node.js | 26 | 20 or newer should do |
| west, cmake, ninja | | with Zephyr's Python dependencies |

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
```

The Zephyr tree is otherwise read-only. Five patches are needed and each is
explained in `patches/README.md`; four of the five are the same underlying
gap, which is that several places in Zephyr assume an architecture is in-tree
or assume a linker script exists.

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

Determinism, which is the point of virtual time:

```sh
zephyr-wasm/scripts/check_determinism.sh build-sem/zephyr/zephyr.wasm --max-time 60000
```

```
deterministic: two runs produced identical output (143 lines)
```

## Host options

`host/run.mjs` takes the module and:

| Flag | Effect |
|---|---|
| `--realtime` | follow the wall clock instead of virtual time |
| `--trace-switches` | log every context switch and idle to stderr |
| `--max-time <ms>` | give up after this much guest time, default 10000 |

`--max-time` is checked between suspensions, so it cannot stop a guest that
never yields. That needs the safepoint work from Milestone 3.

## Layout

```
arch/wasm/            the architecture: switching, interrupts, idle, fatal
include/zephyr/arch/wasm/   its headers, including the zephyr_host ABI
soc/wasm/             the host as a SoC
boards/wasm/wasm_node/      the board
drivers/              console and system timer over host imports
cmake/                toolchain variant, and the build steps Zephyr lacks
scripts/              offsets and section generators, build and check scripts
host/run.mjs          the host harness
spikes/               the Milestone 0 experiments, each with a run.sh
tests/two_threads/    a minimal two-thread reproducer
patches/              the five Zephyr changes, each explained
```
