# Task: Proof of concept for a true `arch/wasm` Zephyr port

## Context

We want to find out whether Zephyr can treat WebAssembly as a real architecture.

This is **not** native_sim built with a Wasm toolchain. Do not reuse `arch/posix`, the native simulator, or pthreads. The kernel should run freestanding in a single `wasm32` linear memory. It uses Zephyr's own libc and scheduler. The host is modelled as a "SoC": it provides a small set of imported functions instead of memory-mapped registers.

Design positions already decided:

- **Context switching** runs on Binaryen **Asyncify** for this proof of concept. Keep switching behind one internal interface, so a later backend using the Wasm stack-switching proposal (typed continuations) can replace it without touching the rest of the arch.
- **Interrupts** are delivered cooperatively. There is a "pending IRQ" word in linear memory. It is checked at safepoints: at minimum in `arch_cpu_idle()`, and later at loop back-edges and function entries through an instrumentation pass. `arch_irq_lock()` masks delivery.
- **Devices are host imports.** There is exactly one import module, `zephyr_host`, with a small, documented ABI.
- **Determinism is a feature.** By default the host should run on virtual time: when idle, jump straight to the next deadline. Real time is an option.
- **Out of scope:** `CONFIG_USERSPACE`, MPU/MMU, SMP, networking, Bluetooth, running in a browser, the stack-switching backend, and upstreaming.

## Environment

- **Zephyr workspace:** `/Users/jberi/code/zephyr-things/wasm-zephyr`. Treat the zephyr tree as read-only.
- **Proof-of-concept module:** `/Users/jberi/code/zephyr-things/wasm-zephyr/zephyr-wasm`, a new git repo and out-of-tree Zephyr module.
- **Tools:**
  - clang/lld with the wasm32 target (LLVM 17 or newer)
  - Binaryen `wasm-opt`
  - Node.js 20 or newer
  - `wasm-objdump` / `wabt` for inspection

Check all of these first. If any are missing, stop and report exactly what is needed.

## Ground rules

1. Everything goes in the out-of-tree module:
   - `zephyr/module.yml` sets `arch_root`, `soc_root` and `board_root`.
   - If a change to the zephyr tree is truly unavoidable, keep it as a numbered patch in `patches/`, with a comment explaining why.
2. Keep `DESIGN.md` as a record of decisions and the host ABI, and `NOTES.md` as a running log of findings, dead ends and measurements. Update both as you go.
3. Commit after each milestone with a clear message.
4. Retire risk first. If a spike shows an approach can't work, record the evidence in `NOTES.md` and propose alternatives before building around it.
5. Don't silence problems by disabling kernel features without recording it. Every Kconfig you force off gets a line in `DESIGN.md` saying why.

## Milestone 0: Spikes (do these before writing the arch)

**A. Linker sections.** Zephyr depends on section placement: iterable sections, `SYS_INIT` levels and priorities (sorted by name), and device ordering. wasm-ld has no linker scripts. Find out, with small C test programs:

- Whether wasm-ld emits `__start_<sec>` / `__stop_<sec>` for data segments with C-identifier names.
- How it orders input segments that share a name. Is ordering by name or priority achievable?
- Whether segment names containing dots (Zephyr's convention) can be preserved or mapped.

Then decide between:

- (a) native wasm-ld section support plus renaming macros, and
- (b) a two-pass build. The first link scans the symbols, a script generates sorted C arrays, and the result is recompiled and relinked. Zephyr already has a multi-stage link you may be able to hook.

Record the decision.

**B. Offsets header.** `gen_offset_header.py` parses ELF. Choose a Wasm-compatible way to produce `offsets.h`: parse Wasm object symbols, or emit the constants into a custom section. Don't use host-native compilation of `offsets.c`, because struct layout differs from wasm32.

**C. Asyncify fibers.** In a standalone C + Node test, show two or more "threads", each with its own shadow-stack region and Asyncify buffer, switching back and forth under a host-side driver loop. Measure the code-size and speed overhead of `wasm-opt --asyncify`, and use `--asyncify-imports` / onlylist to keep instrumentation narrow.

## Milestone 1: Minimal arch, SoC, board and toolchain

- `arch/wasm/`: Kconfig, CMake, `include/zephyr/arch/wasm/` headers (`arch.h`, `arch_inlines.h`, `thread.h`, `exception.h`, `irq.h`), and core sources.
- **Thread creation and switching:**
  - Prefer `CONFIG_USE_SWITCH` with `arch_switch()`. Use `arch_swap()` if it is clearly simpler, and record why.
  - `arch_new_thread()` splits the `K_THREAD_STACK` object into the shadow-stack region and the Asyncify save buffer. Document the split.
  - Implement the `z_cstart` path from the dummy thread to main.
- **IRQs:**
  - IRQ lock/unlock, and `arch_is_in_isr()`.
  - A software ISR table (dynamic interrupts, no `gen_isr_tables` if avoidable).
  - The dispatcher that is called when the pending-IRQ word is set.
- **Idle:** `arch_cpu_idle()` / `arch_cpu_atomic_idle()` check for pending IRQs, then call the host `wait_for_event` import (an Asyncify suspension point).
- **Fatal errors:** call a host `fatal` import with the reason code. Note in `DESIGN.md` that traps kill the instance and can't be recovered from.
- **Supporting pieces:**
  - A system timer driver backed by host imports (monotonic time, set alarm).
  - A console via the `printk` char-out hook.
- **SoC and board:** `soc/wasm/node` and board `wasm_node` (hwmv2 `board.yml` / `soc.yml`), with devicetree describing the host-provided devices.
- **Toolchain:** CMake support for clang/wasm-ld targeting `wasm32-unknown-unknown`, freestanding, with picolibc or the minimal libc, and a post-link `wasm-opt --asyncify` step. It must work with `west build`.
- **Host harness:** `host/run.mjs`. It loads `zephyr.wasm`, implements the `zephyr_host` imports and drives the Asyncify loop. Flags: `--realtime` (default is virtual time), `--trace-switches`, and `--max-time`.

## Milestone 2: Acceptance

These must pass from a clean checkout, with commands written up in `README.md`:

1. `west build -b wasm_node samples/hello_world` followed by `node host/run.mjs build/zephyr/zephyr.wasm` prints the boot banner and the greeting, then exits cleanly.
2. `samples/synchronization` shows the two threads alternating correctly, with `k_msleep` honored. In virtual-time mode it finishes almost instantly with identical output on every run.
3. At least `tests/kernel/semaphore/semaphore` or `tests/kernel/common` runs under ztest and reports its results. Record which tests fail and why.
4. Two runs in virtual-time mode produce byte-identical output. Add a script that checks this.

## Milestone 3: Stretch goals (only if everything above is green)

- **Preemption:** add a safepoint instrumentation pass (Binaryen pass or clang flag) that checks the pending-IRQ word at loop back-edges. Show time slicing between two busy-looping threads of equal priority with `CONFIG_TIMESLICING`. Measure the overhead.
- **Instruction-count time:** optionally drive the virtual clock from counted safepoints to get fully deterministic replay.
- **Twister:** a custom runner so twister can execute `wasm_node` builds.
- **UART and shell:** a UART driver over host imports, and `samples/subsys/shell/shell_module` working interactively in a terminal.

## Final report

When you stop, write a summary in `NOTES.md` covering:

- What works.
- The linker-section approach you chose and how fragile it is.
- Asyncify overhead numbers.
- Every kernel feature you disabled.
- Which parts would change if the stack-switching proposal were available.
- Your view on the biggest obstacles to upstreaming.
