# DESIGN — arch/wasm for Zephyr

A record of decisions and the host ABI. Findings, measurements and dead ends
live in `NOTES.md`; the task statement lives in `BRIEF.md`.

## 1. Scope and shape

The kernel is built as a freestanding `wasm32-unknown-unknown` module. It owns
one linear memory. There is no host OS inside the module: no pthreads, no
`arch/posix`, no native_sim. Zephyr's own libc and scheduler are used.

The host (Node.js, `host/run.mjs`) plays the role of a SoC. Everything the
kernel would reach through memory-mapped registers is instead an imported
function in a single import module named `zephyr_host`.

Out of scope, as set by the brief: `CONFIG_USERSPACE`, MPU/MMU, SMP,
networking, Bluetooth, browsers, the stack-switching backend, upstreaming.

The browser exclusion no longer holds. The brief ruled it out and the port then
ran in one without a kernel change, so the browser is now the target rather
than an excursion: `ROADMAP.md` and issue #1 set out what that means. The rest
of the list stands.

## 2. Decisions

### D1. Workspace layout
The module repo `zephyr-wasm/` is both the west manifest repo and the Zephyr
module. Zephyr is pinned in `west.yml` to main commit `e201b84b` (v4.4.99).
No Zephyr modules are imported; the port needs no HAL and uses the minimal libc.

### D2. Toolchain
Homebrew LLVM (clang + wasm-ld, matched versions) driven through a module-owned
toolchain variant `wasm-clang`. The Zephyr SDK's clang has no wasm32 target and
Apple clang ships no wasm-ld, so neither is usable as a pair.

`TOOLCHAIN_ROOT` is a single path and is not a `module.yml` setting, so the
module supplies the whole set: `cmake/toolchain/wasm-clang/`,
`cmake/compiler/wasm-clang/`, `cmake/linker/wasm-ld/`, `cmake/bintools/wasm/`.

### D3. Context switching: Asyncify, behind one interface
Switching goes through a single internal interface (`wasm_ctx_*` in
`arch/wasm/include/`), so a stack-switching backend can replace it later
without touching the rest of the arch. Backend chosen for this PoC: Binaryen
Asyncify.

### D4. Interrupts: cooperative, checked at safepoints
A pending-IRQ word in linear memory is set by the host and checked at
safepoints. `arch_irq_lock()` masks delivery rather than disabling anything in
the engine. Minimum safepoint is `arch_cpu_idle()`; loop back-edges come later
via an instrumentation pass (Milestone 3).

### D4a. The interrupt lock is per-thread

`arch_irq_lock()` masks delivery by writing a word, but that word is per-thread
state, not global. A thread that blocks while holding the lock must not leave
the rest of the system, and the idle loop in particular, running masked: the
dispatcher would never run and nothing would ever wake. `arch_switch()` saves
the mask into the outgoing thread and restores it from the incoming one.

Interrupt dispatch is also not a reschedule point here, the way returning from
an interrupt is on hardware. The dispatcher is an ordinary call and
`arch_is_in_isr()` is true while it runs, so anything it makes ready is
deferred; `arch_cpu_idle()` reschedules explicitly afterwards.

### D4b. Preemption through safepoints

Nothing preempts a running wasm function, so a thread that never calls the
kernel cannot be interrupted. `CONFIG_WASM_SAFEPOINTS` inserts a call at the
top of every loop body after linking, and the interrupt is taken there. The
pass runs before Asyncify so those calls can suspend.

It needs a second piece that is not optional. Under virtual time the clock
only moves when the kernel idles, so a spinning thread freezes it, and a
frozen clock means the timer never fires. Every
`CONFIG_WASM_SAFEPOINTS_PER_TICK` safepoints the guest calls the host's
`safepoint_tick` import, and the host advances time and raises any deadline
that has passed.

Cost: 1.023x code size, and 2.28x wall time on a tight arithmetic loop, which
is the worst case. The acceptance suite shows no perceptible change.

### D5. Determinism by default
The host runs on virtual time. When the kernel idles, the host jumps straight
to the next deadline. `--realtime` opts out.

## 3. Host ABI: import module `zephyr_host`

To be filled in as Milestone 1 lands. Sketch:

| Import | Signature | Purpose |
|---|---|---|
| `console_write` | `(ptr: i32, len: i32) -> ()` | console / printk char-out |
| `time_now_ns` | `() -> i64` | monotonic clock |
| `set_alarm_ns` | `(deadline: i64) -> ()` | program the next timer interrupt |
| `wait_for_event` | `() -> ()` | idle; suspension point under Asyncify |
| `uart_poll_out` | `(c: i32) -> ()` | one byte out |
| `uart_poll_in` | `() -> i32` | one byte in, or -1 when none is waiting |
| `safepoint_tick` | `() -> ()` | progress report, so time moves while spinning |
| `fatal` | `(reason: i32, arg: i32) -> ()` | unrecoverable error |

Traps kill the instance and cannot be recovered from: a Wasm trap unwinds to
the host with no way back into the module. Fatal errors therefore go through
the `fatal` import, not through a trap, so the host can print a diagnosis.

### D5a. Deciding a run has finished

Under virtual time the host is the only thing that can decide a program has
finished, so it has to be careful about what the guest actually said. The
kernel never sends a "never" sentinel: with no near deadline it clamps to one
about two days out. Reading that as "no alarm" ends runs early, because the
kernel idles between being woken and programming its next real deadline.

The host keeps a clamped deadline as a real deadline and flags it. A run ends
only after the kernel wakes from a clamped deadline, does nothing, and asks
for another, twice in a row. Waking from a real deadline counts as progress.

### D6. Linker sections: renaming where order is free, generation where it is not

Spike A (`spikes/a-sections/`) showed wasm-ld synthesises `__start_`/`__stop_`
for C-identifier section names but never orders segments by name, has no
`--defsym`, and errors out on a reference to a section nothing defines.

The port therefore splits the problem:

**Unordered families use renaming.** For iterable sections whose order carries
no meaning, the module shadows the naming macros so the section name is a C
identifier, and takes `__start_`/`__stop_` as the list bounds. This covers
most of `STRUCT_SECTION_ITERABLE`. Because an absent section breaks the link,
each family the kernel references gets one anchor entry emitted by the module.

**Ordered families are generated.** Init entries cannot work this way:
`z_sys_init_run_level` in `kernel/init.c` walks `levels[level]` to
`levels[level+1]`, so all entries must be one contiguous block sorted by level
then priority. Instead a build step reads the pass-1 objects, recovers each
entry's level and priority from the segment name Zephyr already encodes
(available in the `linking` custom section), sorts, and emits a C file that
defines the six per-level arrays adjacently in one translation unit. Spike A
question 9 confirmed those land contiguous in declaration order and that the
kernel's own walk then visits the right entries, so `kernel/init.c` needs no
patch.

Device order is left as link order. With `CONFIG_DEVICE_DEPS=n` the device
list is only iterated and bounded, never indexed by devicetree ordinal, so the
numeric sort the ELF build does is not needed. This is a PoC simplification
and is the first thing to revisit if device lookup misbehaves.

As built, with the detail spike A could not have predicted: several iterable
lists are pay-per-use and simply absent from a given image, which a linker
script renders as an empty range and wasm-ld rejects outright. Every family is
therefore given a weak, zero-length bound pair that the real symbols override
wherever the section exists.

How fragile this is: the renaming half is solid, since `__start_`/`__stop_` is
a documented wasm-ld feature. The generated half depends on two things that
are conventions rather than guarantees: Zephyr keeping level and priority
encoded in the section name, and wasm-ld keeping declaration order within a
translation unit. Both are stable in practice, and both fail loudly rather
than silently if they change.

### D7. Offsets header: constants as data, read from assembly

Wasm has no absolute symbols, and the inline-asm `.equ` that every other
architecture uses for `GEN_ABSOLUTE_SYM` is a hard LLVM backend failure, not a
graceful one (spike B). The port emits each constant as real data in a
`z_offsets` section and recovers the value from the compiler's assembly
output, where it is a label followed by `.int32`. `scripts/gen_offsets_wasm.py`
replaces `scripts/build/gen_offset_header.py`, substituted by redefining
`zephyr_constants_library` from `arch/wasm/CMakeLists.txt`, which the root
`CMakeLists.txt` reaches before it declares the offsets library.

Reading assembly rather than the object was chosen deliberately: it is one
regex over output the compiler is obliged to produce, where the alternatives
are scraping two `wasm-objdump` reports or writing a wasm binary parser.

Struct layout has to come from the target compiler. For one representative
struct the host reports 32 bytes and wasm32 reports 16, so compiling
`offsets.c` natively, as the brief warns, would be wrong by a factor of two.

### D8. Thread stack split, and why the full Asyncify pass

Spike C settles the shape of a thread. Each `K_THREAD_STACK` object is split
in two: the low part is the C shadow stack that `__stack_pointer` walks, and
the high part is the Asyncify buffer holding unwound wasm frames. A switch
swaps both, because Asyncify saves the wasm frames but does not touch
`__stack_pointer`. wasm-ld exports that global and the host can write it.

The buffer is carved from **below** `stack_ptr`, not above it.
`ARCH_THREAD_STACK_RESERVED` is supposed to make the kernel hand over a
`stack_ptr` that already excludes the reserved bytes; measured, it does not,
and `stack_ptr` arrives at the top of the stack object. A buffer placed above
it lands in the next thread's stack object, so unwinding one thread overwrites
another thread's `k_thread` structure. Taking it from below keeps it inside
the thread's own object either way.

Sizing comes from the measurements: the buffer needs about 88 bytes plus 32
per frame live at the moment of the yield. The reserved split will be a
Kconfig with a conservative default, because a buffer that is too small does
not fail cleanly. Asyncify does not bounds-check it. In the spike a 248 byte
buffer absorbed 1112 bytes and carried on, silently overwriting whatever
followed, and `asyncify-asserts` does not add a bounds check. The port places
the buffer at the top of the stack object so an overflow runs into the next
guard rather than into live thread state.

Kernel stacks need the same reservation as thread stacks. The idle thread and
the system work queue run on `K_KERNEL_STACK` objects and suspend like any
other thread, so `ARCH_KERNEL_STACK_RESERVED` matches
`ARCH_THREAD_STACK_RESERVED`; without it their Asyncify buffers land in
whatever follows the stack.

Thread stacks have to be sized with the reservation in mind. The default main
stack of 1024 bytes is smaller than the 4096-byte buffer reservation, which
makes the split run off the bottom of the object, so `wasm_node_defconfig`
raises the defaults. Every thread pays for a buffer whether or not it ever
suspends deeply.

The port uses the **full** Asyncify pass, not `ignore-indirect` and not an
onlylist. Both narrowing options break the case Zephyr depends on: a yield
reached through an indirect call, which is how thread entries, init handlers
and ISR table entries are all reached. In the spike those builds ran straight
past the yield instead of suspending. A correct onlylist, naming every frame
that can be live across a yield, turns out to cost exactly what the full pass
costs anyway, because Binaryen already instruments only what can reach a
suspending import. There is nothing to win.

The measured cost is 1.22x code size on a kernel-shaped module, and no
measurable throughput cost on code that does not yield. A switch is about
200 ns plus 12 ns per live frame.

### D8a. No suspension inside a function that never returns

Asyncify instruments a call site so control can resume there later. Past a
call the compiler has been told never returns there is no resume point, so the
callers are not instrumented and an unwind returns through frames that then
keep executing.

That rules out implementing `arch_switch_to_main_thread` as a suspension
point, since Zephyr declares it `FUNC_NORETURN`. The port therefore does not
select `CONFIG_ARCH_HAS_CUSTOM_SWAP_TO_MAIN` and reaches the main thread
through the kernel's generic path, which goes through `arch_switch()` from the
dummy thread and is an ordinary returning function.

The rule generalises: no Zephyr API declared noreturn may contain a suspension
point on this port.

### D8b. Indirect calls are type-checked, so a mis-cast entry point traps

Wasm checks the signature at an indirect call against the type recorded for
the table entry, and a mismatch is a trap, not a coercion. Every other
Zephyr target tolerates a function pointer called through the wrong
prototype: the extra arguments are ignored and the call goes through.

So a thread entry that is not exactly `void (*)(void *, void *, void *)`
traps at the point the thread first runs. Both spellings occur upstream:

```c
static void thread_05(struct k_sem *wait, struct k_sem *done);   /* two */
k_thread_create(..., (k_thread_entry_t)thread_05, ...);

void task_low(void);                                             /* none */
K_THREAD_DEFINE(TASK_LOW, STACK, task_low, NULL, NULL, NULL, ...);
```

`tests/kernel/mutex/mutex_api` is the first and `tests/kernel/pending` the
second. Both trap on their first case; giving the entries the signature
`k_thread_entry_t` actually has makes all 11 of the mutex suite pass.

Nothing in the port can fix this, and nothing should: the cast is undefined
behaviour in C and wasm is simply the first target that enforces it. It is
recorded here because it bounds what "runs unmodified" can mean, and because
it is the most upstreamable thing this port has found -- the fix is to give
those entries the right signature, which costs nothing on any target.

### D8c. GPIO is Zephyr's own emulated controller, bridged

The pins are `drivers/gpio/gpio_emul.c`, which is board agnostic and already
implements direction, pull, edge and level triggering and the callback list.
`drivers/gpio/gpio_wasm_bridge.c` only carries it across to the host: a
callback registered on every pin reports output changes, and the GPIO
interrupt reads the host's input levels and hands the changes to
`gpio_emul_input_set_masked()`, which raises the edges and fires the
callbacks as usual.

Writing a driver instead would have been about the same amount of code and
would have meant a learner running this port's idea of GPIO rather than
Zephyr's. The same argument applies to flash, I2C, SPI and the rest: prefer
the emulated backend Zephyr already ships and bridge it.

Levels crossing the ABI are physical rather than logical -- bit N is the
voltage on pin N -- so an active-low button reads 1 when nobody is pressing
it. The bridge forwards only changes, so the host's initial levels have to
match what the pull configuration gives the pins at boot. Both are 1 for a
pull-up, which is how the buttons are wired.

Two details cost an hour and are not obvious from the outside.
`gpio_emul_output_get_masked()` returns `-EINVAL` for a mask with a bit
outside the port rather than ignoring it, so the mask has to be the port's
own `ngpios`. And `gpio_emul` initialises at `POST_KERNEL`, not
`PRE_KERNEL`, so the bridge is `POST_KERNEL` at
`CONFIG_WASM_GPIO_BRIDGE_INIT_PRIORITY`, which sits between the ports at 40
and `gpio-leds` and `gpio-keys` at 90.

### D8d. Interrupt lines have one home

`include/zephyr/arch/wasm/wasm_irq_lines.h` is where a line number is
written down: the guest includes it, the board devicetree includes it, and
both hosts carry a copy that says so. A `wasm,host-intc` node makes it an
ordinary devicetree `interrupts` property rather than a constant in a driver.

The host may raise a line at any time, but it does not write the pending
word when it does. It records the line and applies it at the top of the
driver loop, because a message handler can run before the module has been
instantiated, and because the guest is fully unwound at that point and
nothing else can be halfway through reading the word.

That means an external interrupt is delivered no sooner than the next time
the guest idles or reaches a safepoint, which is the same bound everything
else on this port has.

### D5b. Pacing: waiting afterwards, not deciding beforehand

A sample that blinks once a second is correct under virtual time and
invisible: the host jumps straight to each deadline and the whole run is
over before anyone sees it. `--paced` waits out the difference *after* the
guest has done the work, rather than deciding in advance how long to let it
run.

That ordering is what keeps determinism. The clock is still set to the
deadline and never to however long the host actually slept, so the guest
observes exactly the timestamps it observes under plain virtual time.
Pacing changes when a thing is shown and never what it is, which is checked:
the same build under `--paced`, under `--paced --time-scale 10` and under
plain virtual time produces byte-identical output, in 5.07 s, 0.56 s and
0.06 s respectively.

`timeScale` divides the wait, so the page can offer slow motion and fast
forward without the guest being able to tell. An advance longer than
`PACE_MAX_NS` is taken at full speed: the kernel clamps "nothing soon" to a
deadline about two days out, and sitting through that would be a hang rather
than pacing.

### D9. Link with wasm-ld directly

The clang driver drops the wasm name section. Nothing in the kernel needs it,
but Binaryen does: without names an asyncify onlylist silently matches nothing
and produces a module that never suspends. The toolchain files invoke wasm-ld
directly so names survive and any future narrowing stays possible.

### D10. The UART is polled

Nothing lets the host interrupt the guest: the only mechanism is the pending
word, and that is read at safepoints. An interrupt-driven UART would have
nothing to fire it, so the driver implements `poll_in` and `poll_out` only.
That costs nothing in practice, because a shell thread blocks between
characters.

Input also forced a change in the host. It reads stdin through Node's event
loop, which never got a turn because the Asyncify driver is a synchronous
loop. It now yields whenever the guest idles, which is when input can matter
and never on a hot path.

## 4. Kernel features forced off

Every Kconfig this port forces off, with the reason. Filled in as they are hit.

| Kconfig | Why |
|---|---|
| `DEVICE_DEPS` | Device dependency arrays need a second link stage and a numeric sort wasm-ld cannot do. Off also keeps the build single-stage. |
| `GEN_ISR_TABLES` | The generator reads the linked ELF. The port uses a software ISR table with dynamic interrupts instead. |
| `USERSPACE` | Out of scope per the brief, and its gperf passes are ELF-only. |
| `SYMTAB` | Generator reads the linked ELF. |
| `BUILD_OUTPUT_BIN` | objcopy step, meaningless for a wasm module. |
| `OUTPUT_STAT` | readelf step. |
| `OUTPUT_PRINT_MEMORY_USAGE` | Parses ELF section sizes. |
| `CHECK_INIT_PRIORITIES` | Reads the linked ELF's symbol table. |
| `ATOMIC_OPERATIONS_C` | Not off so much as replaced by the builtin form. The C implementation drags in syscall headers, and a single linear memory with no SMP needs nothing stronger than the compiler builtins. |
| `GEN_ABSOLUTE_SYM_KCONFIG` | Not a Kconfig, but recorded here: made a no-op by patch 0001. Its callers pass names that are themselves macros, which only works with the stringifying assembly form. Nothing reads the resulting symbols at run time. |

All of the above are set in `boards/wasm/wasm_node/wasm_node_defconfig`.

## 4a. What the kernel test suites say

`scripts/kernel_tests.json` records how each of Zephyr's own kernel suites
does here and `scripts/check_kernel.py` re-runs them, so this stops being a
number taken once. At the time of writing, 25 suites and 441 passing cases:
16 pass outright, 4 finish with failures, and 5 do not finish.

The four that fail cluster into two causes and one unknown. `device` fails
exactly the four cases that exercise `DEVICE_API_IS()` on an extended class,
which is patch 0007's documented approximation demonstrated rather than
predicted. `common` and `timer/timer_api` both fail on timer duration
accuracy, and `tickless/tickless_concept` on slice length: a slice ends at
the next safepoint rather than on the tick, so slicing works but its timing
is approximate.

Of the five that do not finish, two are D8b above and are not the port's to
fix. The other three are open.

## 5. Changes to the Zephyr tree

The Zephyr tree is read-only. Anything unavoidable becomes a numbered patch in
`patches/` with a comment, applied by `scripts/apply_patches.sh`.

**0001-toolchain-gen-absolute-sym-for-wasm.patch.** `GEN_ABSOLUTE_SYM` in
`include/zephyr/toolchain/gcc.h` is a per-architecture chain ending in
`#error processor architecture not supported`. There is no generic fallback and
no out-of-tree hook, so a new architecture cannot compile `offsets.c` without
being listed in that file. The patch adds a `CONFIG_WASM` branch that emits the
constant as data. Worth fixing upstream by giving the macro a generic
data-emitting default.
