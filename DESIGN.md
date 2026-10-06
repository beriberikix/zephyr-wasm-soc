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
Eleven Zephyr modules are imported, `fatfs`, `littlefs`, `lvgl`,
`picolibc`, `mbedtls`, `tf-psa-crypto`, `cmsis-dsp`, `nanopb`,
`mipi-sys-t`, and from Zephyr's optional group `tflite-micro` and `chre`,
through Zephyr's own manifest so they stay at Zephyr's pins.
Nothing else is: the port needs no HAL, builds picolibc from its module as
Zephyr's default C library (D11) and from the same checkout for the sysroot
a full C++ library needs (D13), and a full import is hundreds of megabytes
of vendor code. Module code goes through the same section generator and
link-map check as everything else (D6).

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

A handler runs masked, as on a CPU that masks interrupts on entry. Every line
has the same priority, so none may preempt another, nor its own handler; and a
handler has loops, whose safepoints would otherwise take whatever is pending,
the line being handled included, halfway through it. A line raised meanwhile
is taken when the dispatcher comes round again.

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

Every import there is. `include/zephyr/arch/wasm/wasm_host.h` declares
them, and `host/run_wasmtime.py` refuses a module that asks for any other.
Only `switch_to` and `wait_for_event` suspend, and so only those two are
in the Asyncify import list.

| Import | Signature | Purpose |
|---|---|---|
| `console_write` | `(ptr: i32, len: i32) -> ()` | console / printk char-out |
| `time_now_ns` | `() -> i64` | monotonic clock |
| `set_alarm_ns` | `(deadline: i64) -> ()` | program the next timer interrupt |
| `wait_for_event` | `() -> ()` | idle; suspension point under Asyncify |
| `switch_to` | `() -> ()` | context switch; suspension point (D3) |
| `safepoint_tick` | `() -> ()` | progress report, so time moves while spinning |
| `fatal` | `(reason: i32, arg: i32) -> ()` | unrecoverable error |
| `entropy_get` | `(ptr: i32, len: i32) -> ()` | seeded bytes, or the platform's (D5) |
| `uart_poll_out` | `(port: i32, c: i32) -> ()` | one byte out of UART `port`: 0 the console, 1 an HCI line (D10, D8p) |
| `uart_poll_in` | `(port: i32) -> i32` | one byte in, or -1 when none is waiting |
| `gpio_out` | `(port: i32, values: i32) -> ()` | output pins changed (D8c) |
| `gpio_in` | `(port: i32) -> i32` | input pin levels (D8c) |
| `storage_attach` | `(ptr: i32, len: i32) -> ()` | where the flash lives (D8h) |
| `reboot` | `(type: i32) -> ()` | a warm reboot (D8h) |
| `display_attach` | `(ptr, w, h, fmt: i32) -> ()` | where the framebuffer lives (D8i) |
| `display_flush` | `(x, y, w, h: i32) -> ()` | a region changed (D8i) |
| `display_blank` | `(on: i32) -> ()` | blanking (D8i) |
| `input_poll` | `(ev: i32) -> i32` | next touch or key event, or 0 (D8i) |
| `sensor_poll` | `(ev: i32) -> i32` | next sensor value, or 0 (D8j) |
| `eth_send` | `(frame: i32, len: i32) -> ()` | a frame for the other board (D8k) |
| `eth_recv` | `(buf: i32, max: i32) -> i32` | next frame's length, 0 for none, -1 if too long (D8k) |

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

A clamp is recognised by its distance from now, not by its value. The alarm
the guest sets is an absolute time. Compared as a value against 100 s, every
alarm after 100 s of guest time counted as a clamp. So long runs ended there
as if finished, and an idle shell stopped its clock (NOTES, tick 51).

### D6. Linker sections: generated order, checked at link

Spike A (`spikes/a-sections/`) showed that wasm-ld:
- synthesises `__start_`/`__stop_` for sections whose names are C identifiers;
- never orders segments by name;
- has no `--defsym`;
- errors out on a reference to a section nothing defines.

Zephyr's linker scripts do two kinds of placement that wasm-ld cannot:

**Init entries** must be one contiguous block sorted by level, then priority:
`z_sys_init_run_level` in `kernel/init.c` walks `levels[level]` to
`levels[level+1]`. A build step reads the pass-1 objects and recovers each
entry's level and priority from the segment name Zephyr already encodes. It
then emits a C file that defines the six per-level arrays adjacently in one
translation unit and fills them at boot by copying. Spike A question 9
confirmed those arrays land contiguous and in declaration order. Nothing
points at an init entry, so copying is safe.

**Iterable sections** are each collected with `SORT_BY_NAME`, which makes
every family a contiguous list in key order. The first version of this port
assumed the order carried no meaning and let wasm-ld synthesise bounds for an
identifier-named section. It does carry meaning:
- zbus groups a channel's observations by name, and `_zbus_init` computes
  each channel's observer range from that grouping;
- the log subsystem's source ids are positions in its section;
- ztest runs suites in section order;
- the shell lists commands in section order.

The samples sweep found seven zbus applications failing on it.

Entries cannot be copied into order the way init entries are, because code
holds pointers to them. They are ordered in place:

- Patch 0004 names each entry's section `z_iter_<family>.<key>_`, where the
  key is the one the ELF section name sorts on.
- wasm-ld makes one output segment per section name, in the order it first
  meets each name across its inputs, and lays the segments out one after
  another, padding only for alignment. An object file packs all of a
  translation unit's entries for one name into one segment, so reordering
  input files could not do this; per-key names can.
- `gen_sections_wasm.py` writes a file that the build compiles into the
  executable's own sources, so it opens the link line. For every family, in
  order, it holds a zero-length start marker, one zero-length placeholder per
  key in byte order, and a zero-length stop marker. The markers are aligned to
  the family's largest entry. Every real entry joins its key's segment, so the
  family comes out contiguous, in upstream's order, and bracketed by the
  markers, which are the list bounds.
- A family nothing linked contributes to, including the pay-per-use ones that
  once needed anchors and weak fallbacks, is simply `start == stop`.

The failure mode is quiet, so it is checked rather than trusted.
`check_sections_wasm.py` reads the link map as the first post-link step and
fails the build if any family is not exactly one unbroken run of start marker,
keys in order, and stop marker. This catches an object the scan missed, which
would otherwise leave a list silently short.

Each family's markers are defined under two names. The section macros use
`__start_z_iter_<family>` and `__stop_z_iter_<family>`, which patch 0004 points
them at. Every ELF linker script's `ITERABLE_SECTION_ROM/RAM` also defines
`_<family>_list_start` and `_<family>_list_end`, and code that declares the
bounds by hand uses those. Only two families are spelled that way, `net_if`
and `usb_cfg_data`, but the first is the network stack's list of interfaces,
and nothing using the stack linked until the generator defined them too.
They are markers in the same sections, so they have the same addresses.

Device order is now upstream's too, since devices are an iterable family keyed
by level and priority. The same markers could also make patch 0007's
`Z_DEVICE_API_EXT_END` exact, by generating the end of a class together with
the classes that extend it. That has not been needed yet.

How fragile this is: it depends on three things that wasm-ld does and does
not document:
- output segments in first-seen order;
- zero-length retained segments surviving `--gc-sections`;
- layout in segment order.

Spike (tick 1 of this change) confirmed all three on LLVM 21, and the link-map
check turns any change in them into a failed build rather than a wrong list.

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
in two: the Asyncify buffer holding unwound wasm frames, and the C shadow
stack that `__stack_pointer` walks. A switch
swaps both, because Asyncify saves the wasm frames but does not touch
`__stack_pointer`. wasm-ld exports that global and the host can write it.

The buffer lives in the bytes `ARCH_THREAD_STACK_RESERVED` sets aside, and
Zephyr puts those at the **bottom** of every stack object, below the buffer
the thread asked for, where an MPU target keeps its guard. So the object
reads, from low to high: the Asyncify buffer, the headroom of a debugging
build (below), and then the requested stack, which the C stack walks down
from `stack_ptr` at the top. The bottom of that requested stack,
`stack_info.start`, is the bottom of the C stack, which is where Zephyr's
stack sentinel and thread analyzer look for it. A C stack that overflows
runs into its own thread's buffer, never another object.

It was not always so. The first version assumed the reserved bytes were at
the top, found that a buffer placed above `stack_ptr` landed in the next
thread's object, and carved it from below `stack_ptr` instead. That kept the
buffer inside the object, but the C stack then grew down through
`stack_info.start` and the reserved bytes, and the sentinel sat inside the C
stack (below).

Sizing comes from the measurements: the buffer needs about 88 bytes plus 32
per frame live at the moment of the yield. The reserved split will be a
Kconfig with a conservative default, because a buffer that is too small does
not fail cleanly. Asyncify does not bounds-check it as it writes. In the
spike a 248 byte buffer absorbed 1112 bytes and carried on, silently
overwriting whatever followed, and `asyncify-asserts` does not add a bounds
check. What does exist is a check afterwards: `asyncify_stop_unwind()`
traps if the unwind ended past the buffer's end, with a bare `unreachable`.
The host makes the same comparison just before calling it, so an overflow
stops the run with a message that names the buffer and the Kconfig option.
Either way it is found after the damage, not before.

The default is `CONFIG_WASM_ASYNCIFY_BUFFER_SIZE=4096`, and 8192 in a build
with mbedTLS or zperf. A TLS handshake suspends from deeper than anything
else measured: `tests/net/socket/tls` unwound 4,160 bytes, which overflowed
the default and passed with the larger one. A zperf upload runs in the
shell thread, below the command handler, the shell and the socket layer,
and unwound 4,240. Tying the larger default to what needs it, rather
than raising it for every build, keeps the cost where it is
paid: every thread's stack carries the buffer, and every step-back snapshot
copies it.

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

The C stack below the buffer has no guard either, and it overflows more
quietly than the buffer does. Nothing checks it: there is no MPU, and wasm
does not trap on a store anywhere inside linear memory. A thread that runs
off the bottom of its stack writes over whatever is linked below, and the
damage shows only when that is next used. The network suites found it. The
ztest thread's 1 KB, upstream's default, was too little for a test calling
down through conn_mgr, net_if and net_mgmt into `k_work`. The overflow
reached the ztest list itself, and five suites trapped much later on a
function pointer that had become zero, which looked exactly like a D8b
mismatch. The board now defaults `CONFIG_ZTEST_STACK_SIZE` to 4096;
upstream already raises it to 2048 for x86, and one suite needed more than
that.

Finding it took a store watch. Binaryen's `--instrument-memory` routes every
load and store through an import, so a scratch host can report the stack
of the store that hits a given address. That turned "a null function in
`test_cb`" into "a `k_work_submit_to_queue` frame spilling an argument into
the ztest list". Zephyr's `CONFIG_STACK_SENTINEL` is the ordinary way to
catch this, and with the layout above it works here. It writes a word at
`stack_info.start` and checks it at every switch, for the outgoing thread,
and after every interrupt that is not nested, which is the architecture's
part: `z_wasm_irq_dispatch()` does it, as arm64's ISR exit does. Upstream's
`tests/kernel/fatal/exception` with `sentinel.conf` overflows a stack on
purpose and expects both checks to catch it. Here they do, and the whole
suite passes, its CPU exceptions included (D14).

Before the layout was fixed, the sentinel reported an overflow at once on
a thread whose test did nothing. The 4 KB ztest thread's `stack_info.start`
was the top of its C stack, not the bottom. It is off by default, as
everywhere: one load and compare per switch and interrupt.

**A debugging build gets more C stack** (`CONFIG_WASM_STACK_HEADROOM`,
8192 when built `-Og`, as `CONFIG_DEBUG=y` builds, and 0 otherwise). It is
added to the reservation, so every stack object grows by it and the size
the kernel knows about does not change. It lies below `stack_info.start`,
so with the sentinel on, a debugging build's thread that uses it is
reported as overflowing the size it asked for, which is the truth. Optimised, wasm code fits the
stacks upstream sizes for native targets; built for debugging it does not.
`smf_calculator` asks for `CONFIG_DEBUG` and gives its own thread 1 KB,
and it ran off the bottom into what is linked below: first main's timeout
and the shell thread, so the run went silent; with 2 KB more, the log
core's buffer, so it trapped on a corrupted function pointer; with 4 KB
more, the log sources' names, so it printed garbage for its own. With 8 KB
more, and with 16 KB, an eleven-key session printed the same, correctly.
Only a debugging build pays for it.

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

Those changes are written: `upstream/zephyr/` has them as a series for Zephyr,
and `scripts/try_upstream.sh` shows every D8b entry passing with them. Clang's
`-Wcast-function-type-strict` is how to find more. It reports the cast inside
`K_THREAD_DEFINE()` that hides the mismatch. It also reports casts that differ
only in pointer types, which wasm does not trap on, since its check compares
value types and every pointer is an `i32`.

One case is the port's to fix, because it comes from the toolchain rather
than from Zephyr: `main`. Elsewhere `int main(void)` and
`int main(int argc, char **argv)` are one symbol, and the kernel calls
either through `extern int main(void)`. Clang on wasm gives them different
symbols so that no call can mismatch: the first is `__original_main`, which
is what the kernel's call names, and the second `__main_argc_argv` (plain
`main` when freestanding). A sample written the second way,
`posix/eventfd` after the Linux manpage, was never linked to the call at
all. The kernel's weak default `main` ran instead, and the sample printed
nothing. `arch/wasm/core/main.c` is a second weak default, which calls
`main(0, {NULL})` if the application has one. The arch library is linked
whole, ahead of the kernel's, so its default is the one used, and an
application with `main(void)` still replaces it.

That found a D8b in Zephyr's file layer (`upstream/zephyr/0017`):
`zvfs_rw()` calls every file's `read_offs()` and `write_offs()`, which
take an offset and only shared memory fills. Eventfd, sockets and the
console fill `read()` and `write()`, the other members of the same unions,
so on wasm every `read()` or `write()` on one of them traps.

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

**A line nobody has enabled yet keeps its interrupt.** The host holds a
raised line back until the guest's `irq_enabled_mask` has it, as the pending
register of an interrupt controller does, and only then writes it into the
pending word. And both sides decide whether there is work on the interrupts
the guest could actually take: pending, enabled, and not masked. Idle
compares against those, and so does the host when it decides whether to let
time pass.

Both halves come from one bug. The page levels the Tilt pad with a reading
as the run starts, so `WASM_IRQ_SENSOR` was raised before the sensor bridge
had enabled its line, and the bit sat in the pending word where nothing
could take it. The host saw a pending interrupt, so it never moved the
clock to the next deadline. The bmi160 driver's boot-time busy-waits, about
59 ms, then crept forward one safepoint tick at a time. Each tick was an
Asyncify round trip, about 12 million of them, and the terminal stayed
blank for eight seconds of CPU time. The guest had the same flaw in its own
idle, which returned at once, and forever, for a bit it could not take.
CI never saw it, because its scripted reading came 1.5 s in. The
accelerometer entry now sends one at 0 ms as well.

**A busy-wait takes interrupts.** `k_busy_wait()` cannot spin against
virtual time, so `arch_busy_wait()` asks the host to move the clock to its
deadline. The host has one alarm, and the kernel's timer is using it. The
wait used to replace it with its own deadline, so a timer that fell due
during the wait fired only after the wait returned, where hardware takes it
while spinning. Now the wait stops at whichever comes first, the kernel's
deadline (`z_wasm_timer_alarm_ns`, recorded by the timer driver) or its own,
and takes whatever is pending each time; with interrupts masked it only
waits, as a CPU with them locked would. The kernel's alarm goes back at the
end. Four kernel suites that had been put down to time slices ending at
safepoints passed once this was fixed (section 4a).

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

The wait is measured against an anchor, the guest and wall clocks at one
moment, not step by step. Waiting out each step's own difference loses the
time the guest itself took, every step, and a paced clock drifted behind the
wall clock by that much. The anchor is reset when the speed changes, after a
step back, after a jump too long to wait out, and when the guest has fallen
more than `PACE_BEHIND_MS` behind, so a slow stretch is not followed by a
burst of catching up.

One paced case does let the wall clock in: a run that can hear from outside,
an interactive one or one on a relay, while it idles. Jumping to the next
deadline there leaves the clock standing until someone does something, so a
five-second button press is logged as lasting no time; and whatever arrives
while the host waits out the jump lands at once when the wall clock catches
up. A relay's DHCP offer reached the client just as its retransmit timer
fired, so it never matched; a page's keys reached the shell as one burst.
Instead the guest's clock advances with the wall clock up to its next
deadline, the host sleeping up to `PACE_IDLE_MS` at a time so it does not
spin. The kernel's "nothing soon" clamp is never waited for. That run was
never deterministic, since it reads a person or a network; every run CI
compares is scripted, and not affected.

The interrupt-driven shell is what made this matter. Its polled predecessor
kept a 10 ms timer running, so no jump was ever longer than that.

### D8e. The host asks rather than reads

A page that shows the kernel's threads needs the kernel's thread list, and
the obvious way to get it is to hand the host the generated struct offsets.
That would be a mistake worth naming: the offsets are generated per build
precisely because they are not stable, and a host that knew them would go
quietly wrong whenever a struct moved rather than failing.

So the guest answers questions instead. `z_wasm_inspect_threads()` walks
`_kernel.threads` and fills an array of `struct wasm_thread_info`, which is
twelve 32-bit fields in a fixed order and the only Zephyr shape the host
knows. Adding a field costs an edit on each side, which is the usual price
of an ABI and cheap at this size.

Three rules make the call safe, and all three come from where it happens.
The host calls it between steps, where the guest is fully unwound, Asyncify
is `NORMAL`, nothing is mid-switch and `_kernel.cpus[0].current` already
names the thread that will run next. It takes no lock, because there is one
CPU and nothing else is running. It must not suspend, because a suspension
outside the driver loop would corrupt the Asyncify state the host is
holding. And it must not be instrumented, because a safepoint inside the
walk would dispatch interrupts and reschedule from a call the kernel never
made -- so it is in the safepoint pass's skip list, which now refuses to run
if it cannot find a name it was told to skip.

It runs on a stack of its own rather than spending the headroom of whichever
thread happens to be suspended when the host asks.

**What a thread waits for.** The last three fields answer the question a
thread table raises first: a thread is `pending`, but on what?
- `pended_on` is the wait queue the thread is on, which is the kernel
  object's address for every object whose wait queue comes first.
- `held_by` is who holds it, when it is a mutex. A wait queue does not say
  what it belongs to, and without `CONFIG_USERSPACE` nothing else records
  that either, so the guest infers it. It reads the queue as a `k_mutex`'s
  `wait_q` and believes the owner it finds only if that owner is a thread in
  the kernel's list, is not the waiter, and holds the lock at least once. A
  semaphore with a waiter has a count of zero there, and most other objects
  hold something that is not a thread. An object that happened to keep a
  thread pointer in that place would be misread as a mutex. That is the
  price of not having a type tag, and the page says "held by" for this case
  only. `CONFIG_OBJ_CORE` would give an exact answer, at the cost of a list
  node in every kernel object of every build, which is more than a thread
  table is worth.
- `timeout_ms` is what is left on the thread's timeout, or -1 with none:
  when a sleeping thread wakes, or when a waiting one gives up. The guest
  asks the kernel, through `z_timeout_remaining()`.

That call is where the "not instrumented" rule reaches past this file. The
skip list protects the walk's own loops, which is why its helpers are
always inlined, but not the functions it calls, and `z_timeout_remaining()`
walks the timeout list. A safepoint there could not dispatch, since the
kernel holds its lock, but each safepoint counts towards the next progress
report, and a report moves virtual time: looking would change what was
looked at. So the link exports `z_timeout_remaining` whenever inspection and
a clock are both built in, and the build passes its name to the safepoint
pass, which leaves it alone under the same rule: a name it is told to skip
must be exported, or the pass refuses to run. The kernel's own callers lose
those safepoints too. They held the lock already, so all they lose is
counting.

The records sit at the top of the inspect stack, 48 bytes for each of up to
24 threads, so the stack grew from 1 KB to 2 KB to keep the walk's own
headroom.

### D8f. A step is a suspension

Pausing and stepping are nearly free here, and it is worth being clear about
why: the driver loop is already one step per suspension, so "stopped between
two context switches" is a state the host is in thousands of times a second
anyway. Offering it costs a flag.

That also sets the granularity. A step is one suspension -- the guest runs
until it switches threads or idles -- which is exactly the unit a learner
wants when watching a scheduler hand off. Stepping at instruction or
safepoint granularity would mean making `safepoint_tick` suspend, which
costs a full unwind on every loop iteration, and is a different feature
rather than a finer setting of this one.

### D8g. Stepping backwards is a memcpy

The issue is right that this is the thing hardware cannot offer, and it is
worth saying how little it costs here. The whole machine is one linear
memory plus a couple of globals: a module is about 128 KB of memory, so a
snapshot is a copy of that and a restore is a write.

What is not in that buffer is the host's own bookkeeping -- the virtual
clock, the alarm and its clamp flag, the quiescence count, the switch
counter, the entropy state, the pending input, the GPIO levels, and the map
of which Asyncify buffer belongs to which context. All of it has to be
copied alongside, and the context map rebuilt rather than shared, since
restoring must not hand back objects the run has gone on mutating.

Asyncify needs nothing special. Its buffers are in linear memory and so are
captured with everything else, and a snapshot is only ever taken between
steps, where its state is `NORMAL`.

Snapshots are taken only while paused, and bounded. Copying 128 KB on every
suspension would be thousands of copies a second in service of nothing;
copying it when a person asks for a step is free.

**What was printed goes back too.** A terminal can only be written to, so
the undone steps' output stayed on the screen, and stepping forward again
printed it a second time. The host counts the bytes the guest has printed,
the count is part of the snapshot, and every state it reports carries it.
The page keeps what it has shown, up to a megabyte. When a state arrives
with a smaller count than it has shown, the page cuts its record back to
that point, resets the terminal and writes the record again. Output and
state come down the same ordered channel from the worker, so the two counts
always refer to the same moment.

### D8h. Flash lives in linear memory, and the host keeps it

The board's flash is upstream's flash simulator (`zephyr,sim-flash`), the
one native_sim uses. Off the posix arch it keeps the whole device as one
static array, which on this board is part of linear memory, and it erases
it at init. It needs no port code.

It is 256 KB rather than native_sim's 2 MB, because every step-back
snapshot (D8g) copies linear memory. That is room for the storage samples:
- a 64 KB `storage_partition`, 16 erase blocks, where NVS, ZMS and settings
  live;
- a 192 KB slot that only exists because `zephyr,code-partition` has to name
  something.

**Keeping it needs no asynchronous import.** Persistent storage is
asynchronous in a browser (IndexedDB) and the driver loop is not, so the
host does all of it from outside the guest:
- `flash_wasm_host.c` runs straight after the driver, at `POST_KERNEL`
  priority 51. The priority is checked against `CONFIG_FLASH_INIT_PRIORITY`
  at build time.
- It calls `storage_attach(ptr, len)`, a synchronous import, so the host can
  copy a saved image into the array before anything reads it.
- The host reads the array back whenever the guest is not running. The page
  loads its image from IndexedDB before the run starts, and saves each copy
  the worker sends without anyone waiting on the write.

A host with no image leaves the flash erased, so runs stay repeatable and the
determinism and two-engine checks are untouched.

**A reboot is a new instance with the flash carried over.** This is what a
reset means on hardware. `sys_arch_reboot` calls the `reboot` import, which
throws out of the guest instead of unwinding: the instance it leaves behind is
discarded, so there is nothing to unwind cleanly. The host then:
- keeps the attached image;
- instantiates the same module again;
- restarts uptime, taking the time already used off the run's allowance;
- stops after 64 reboots, so a sample that reboots for ever still ends.

Snapshots include flash for free, since it is linear memory, so stepping
backwards over a write undoes the write.

**Stop ends the Worker; a flash build gets half a second first.** The page
used to ask a run's Worker to stop and wait for it to say it had. A Worker
hears that only when its driver loop yields. A guest in one long step, such
as LVGL drawing its first screen, does not yield for seconds. A paced guest
that had fallen behind the wall clock never yielded at all. Such a Worker
went on using a core after Stop or a change of build, and the next run
booted slowly beside it. Now the page terminates the Worker, and both of a
pair's, at once. A build that keeps flash is the exception. Its writes
since the last save would be lost, so it is asked to stop first, and given
500 ms to hand over its image. It is terminated whether it answers or not.
Separately, a paced run now lets its host's event loop have a turn at least
every 50 ms, so Stop, a change of speed and a peer's frames are always
heard. Only when things happen changes, not what the guest sees.

### D8i. The display and input are bridged, not emulated

native_sim's `display_sdl` and `input_sdl_touch` put real driver APIs over
a host window. The same shape works here one layer lower, with the page as
the window.

**Display.** `wasm,host-display` is a framebuffer array in linear memory,
320×240 like native_sim's. It is RGB565, not native_sim's ARGB8888, for two
reasons:
- LVGL defaults to 16-bit colour, so its samples need no board
  configuration. native_sim gets away with ARGB8888 only because its samples
  ship a `boards/native_sim.conf`.
- It is 150 KB instead of 300 KB of linear memory, and every step-back
  snapshot copies linear memory (D8g).

The node states `pixel-format` in devicetree because samples size their
buffers from it; `draw_touch_events` assumes ARGB8888 without it.

The guest calls three imports, none of which suspends:
- `display_attach`, at init;
- `display_flush`, after each write, which only widens the host's dirty
  rectangle;
- `display_blank`.

The host reads the pixels whenever the guest is not running, exactly as it
reads the flash (D8h). The page receives a frame from the worker at most
once per 50 ms tick, as RGBA, and draws it on a `<canvas>`. Under Node,
`--screenshot` writes the last frame, which is how CI checks what a build
drew, not just what it printed.

**Input.** `wasm,host-input` is a device with an interrupt line:
- The host queues events and raises `WASM_IRQ_INPUT`.
- The ISR reads one sample with `input_poll()`, a synchronous import: events
  up to and including one with sync, each passed to `input_report()`. The host
  raises the line again while it has more. So a touch controller's rhythm is
  kept, and the input thread drains its queue between samples. Draining
  everything in one interrupt overflowed that queue when a drag arrived
  between two steps of a paced run.
- A touch is reported as `input_sdl_touch` reports one: X, Y, then
  `BTN_TOUCH` with sync.
- Keys are Linux key codes.

LVGL's pointer, `input_dump` and `draw_touch_events` therefore all run
against the real input subsystem. Scripted input under Node counts as a
deadline, like a scripted GPIO event (D8c), so a touch test is repeatable.

The board turns `CONFIG_INPUT` on for any build with LVGL, as upstream's
touchscreen boards and display shields do. A sample that uses LVGL leaves
input to the board: `smf_calculator` never asks for it, and before this was
a keypad drawn on the screen that nothing could press.

The display is RGB565 only. `modules/lvgl/screen_transparency` renders at 32
bits, since its point is an alpha channel, and native_sim's display is
ARGB8888; here it draws its labels repeated down the screen. A second pixel
format would double the framebuffer and change every display build, so the
sample is left out for now.

### D8j. Sensors are upstream's emulators, and the host sets what they read

Phase 1's argument (D8c) one layer up: upstream already emulates sensor
chips, on an emulated bus, for its own tests, so this board uses them. The
devicetree has upstream's `zephyr,i2c-emul-controller`, as native_sim does,
with two parts on it:
- a bmi160 as `accel0`, the accelerometer upstream's LVGL chart sample puts
  on native_sim's bus;
- a bmp581 as `pressure-sensor`.

The drivers are the real ones and talk to the chips over the bus. A sample
reading an accelerometer runs every layer it would on hardware except the
silicon. The board turns `CONFIG_EMUL` on for any build that uses sensors,
because the emulated parts do not exist without it; a build that does not
use sensors pays nothing. Neither part has an interrupt line, so their
drivers run without triggers. No upstream sensor emulator drives an
interrupt pin yet, which is what `accel_trig` and the FIFO-streaming samples
wait on.

**Setting what they read.** An emulated chip reports whatever its registers
hold, and a person or a test has to decide what that is. Upstream's tests
call the emulated-sensor backend API, `emul_sensor_backend_set_channel()`.
`wasm,host-sensor-bridge` makes the same call on the host's behalf:
- the host queues readings, each a sensor index, a `sensor_channel` and a
  value in millionths of its SI unit, and raises `WASM_IRQ_SENSOR`;
- the ISR reads them with `sensor_poll()`, a synchronous import, and sets
  each on the emulator as a q31 value with the smallest shift that holds it;
- the driver then reads the value back over I2C, through the chip's own
  scaling. A reading of 1.5 m/s² comes back as 1.49999, from the bmi160's
  16-bit register.

The host keeps only the latest reading per channel, because that is all an
emulator holds, so a page sending one reading per pointer move builds no
backlog. Under Node, `--accel <ms>:<x>,<y>,<z>` scripts a reading, which
counts as a deadline like a scripted touch. On the page, the Tilt pad is
the board seen from above: dragging the dot tilts it, and gravity moves from
Z onto X and Y. With nothing queued the emulators read as they always did,
so an untouched run is byte-identical to one without the bridge.

The bmp581's emulator has no backend API, so its pressure cannot be set.
The pressure samples are `build_only` upstream, and building is all they
need to do.

### D8k. Two boards, one wire

A board with a network interface and nothing to talk to can only talk to
itself, over loopback, and nearly all of networking's samples want a peer.
So two boards share a wire: an Ethernet interface whose frames go to the
host, which hands them to the other board.

**The guest side** is a small driver, `wasm,host-ethernet`
(`drivers/ethernet/eth_wasm_host.c`), with two imports:
- `eth_send` hands the host a whole frame, which it copies before returning;
- `eth_recv` takes the next frame from the other end.

Frames arrive the way touches and sensor values do: the host queues them
and raises `WASM_IRQ_ETH`. The ISR only schedules work, and the work
handler feeds the stack from thread context, so buffer allocation and the
stack's own locking stay out of interrupt context. Checksums are the
stack's to compute. The MAC comes from the board's entropy source, which
the host seeds per board. A MAC from `sys_rand_get()` would not do, since
the network samples set `CONFIG_TEST_RANDOM_GENERATOR`. Two boards would
then draw the same address, and IPv6 duplicate address detection refuses
it.

**The node is off by default.** A build turns it on with the
`wasm-ethernet` snippet, which also sets `CONFIG_NET_L2_ETHERNET`. Without
that, the 139 network suites, which run over loopback or interfaces they
define themselves, would each gain an interface they never asked for.

**The host side is two `Host`s and a relay.**
- On the page, each board has a Worker, and the page passes frames
  between them.
- In Node, `run.mjs --peer` runs both in one process, and each board's
  `ethSend` is the other's `pushEthernet`.

A linked board idles as an interactive one does, rather than ending when
nothing is scheduled: its peer can send it a frame at any moment. It also
follows the wall clock while idle, and fires a deadline when the wall clock
reaches it rather than jumping to it. Otherwise a frame arriving before the
deadline would find a board that already lived at the deadline.

**Both boards run on one clock** (`host/pair.mjs`), so a pair is as
repeatable as a single board. The link used to run in real time: each board
followed the wall clock, frames arrived when they arrived, and a pair's
checks could only be thresholds. Now:

- **One timeline.** Each board keeps its own clock, which starts at zero
  when it powers on, as uptime does. The pair puts both on one timeline:
  a board's time is its epoch, when it was powered on, plus its own clock.
  A reboot moves the epoch on, so the timeline never runs backwards.
- **Frames carry the time they arrive.** `eth_send` stamps a frame with the
  sender's time plus a fixed 100 µs of wire. The receiver keeps its queue in
  that order. A frame is a deadline like a scripted button press: the board
  jumps to it when idle, `IRQ.ETH` is raised once it is due, and `eth_recv`
  hands over only frames that are.
- **The board that is behind runs, as far as the other could still reach
  it.** Nothing the other board sends can arrive sooner than its own time
  plus the wire's latency, so that is the limit. An idle board can send
  nothing before its own next event, so its limit is that event plus the
  latency. A board with nothing to wake it at all sets no limit. A frame
  the running board sends can wake the other sooner than its limit
  assumed, so sending one pulls the sender's limit in to that frame's
  arrival plus the latency. The first version missed this. The other board
  then answered about 10 ms late on every exchange, and echo managed a
  tenth of what it does now. This is conservative synchronisation. Which
  board runs, and how far, depends only on the two clocks.
- **Overshoot is harmless.** A step cannot be interrupted, so a busy board
  can pass its limit by up to a step. A frame then sent to the other board
  may be due before the receiver's clock. It is taken at once, a little
  late, and the same every run, since the order things run in is.
- **Idle and quiescence belong to the pair.** `Host.runUntil(limit)` steps
  one board and says whether it went idle and until when. When both boards
  have nothing to wake them, an unpaced pair is over. A paced one lets its
  time follow the wall clock while it waits for a person, as a single paced
  board does. The kernel's "nothing soon" clamp counts as nothing to wake
  for there too: a board whose only alarm is the clamp, as one with an
  interrupt-driven shell often is, would otherwise jump days ahead in one
  step, past the page's limit.
- **Pacing is the pair's.** Unpaced, in Node, a pair runs as fast as it
  can. On the page, the pair's time, the earlier of its busy boards, is
  held to the wall clock with the single board's anchor logic. That
  changes when things are shown, never what they are.
- **One Worker for both boards on the page.** The site cannot use
  `SharedArrayBuffer`, since GitHub Pages sets no isolation headers, and
  two Workers could only meet by message. So a pair is two `Host`s in one
  Worker, as `run.mjs --peer` already had in Node. Output, state and
  typing are marked with their board.

`check_site` runs every pair twice, and both boards' output must match
exactly. The first run of the echo pair on one clock did 32,000 exchanges
in the time the wall-clock link managed 10,000, and all nine pairs now
check in about a minute.

**A board can be powered on late.** A pair entry's `start_after_ms` starts
its second board that long after the first, in guest time: its epoch.
`run.mjs --peer-delay` sets it in Node. Until then, frames sent towards it
are dropped, as on a cable plugged into nothing. It is there because `coap_client` and
`http_client` send their first request once, with no retry: a client that
boots alongside its server loses that race and gives up. Plugging the
client in second is what a person would do, and it changes nothing in
either sample. The first board is always the one that starts first,
because it is the one `run.mjs` writes to stdout.

**Either board can be typed into.** A board's UART reads whatever is in
the host's input queue, interactive or not; `--interactive` only decides
whether stdin feeds the queue. So the second board's scripted input,
`run.mjs --peer-stdin <file>`, goes straight into its queue when it is
made, and waits there for its shell. For a pair, piped stdin to the first
board is read whole and queued the same way. Arriving through the event
loop, it would land at whatever guest time an unpaced pair had reached by
then. On
the page each terminal already sent its keys to its own board; the browser
check now types a pair's second `ci_stdin` into the second terminal. zperf
is the pair that needed it: one board runs `zperf udp download`, the other
`zperf udp upload`, and each command waits for the one before it, since an
upload holds the shell until it is done.

The first pair is upstream's `echo_client` with `echo_service`, which mirror
each other's addresses as shipped. `echo_server` would be the obvious
server, but its thread entries are `void f(void)` and trap (D8b);
`upstream/zephyr/0010` fixes it.

### D8l. A real network, through someone else's relay

The wire in D8k only reaches another board. To reach a real network, the
same frames go somewhere else. A tab cannot open raw sockets, so something
outside it has to run a TCP/IP stack that ends the board's connections and
makes real ones: NAT, as a home router does, with DHCP and DNS for the
board. The board's side does not change, since its driver already hands
over whole frames and Zephyr's own stack does the rest.

**The protocol is v86's, not ours.** `host/uplink.mjs` speaks v86's
`wsproxy` protocol: one Ethernet frame per binary WebSocket message, both
ways, with nothing else on the wire. Every relay written for v86 speaks it,
including websockproxy, go-websockproxy, wsnic and RootlessRelay, so none
has to be written or hosted here. RootlessRelay is the one README points
to. It runs its own userspace stack, so it needs neither root nor a TAP
device (`ENABLE_WSS=false npx rootlessrelay`). Node 22 and a Worker both
have WebSocket built in, so one small module serves `run.mjs --uplink` and
the page, and nothing is installed.

What else was looked at, and why not:
- **Port tunnels** (wstunnel, frp, bore, chisel, cloudflared) carry TCP and
  UDP streams, not frames, so a stack would still be needed to end the
  board's connections. wstunnel's client is not a plain browser WebSocket
  either: its framing names the destination. A tunnel is useful beside a
  relay, to publish a port the relay forwards, and that needs nothing here.
- **passt** does the same job as RootlessRelay without root, but over a
  Unix socket. The page cannot reach one without a relay of its own in
  front.
- **Socket offloading**, the host implementing the socket API, would bypass
  the IP stack, which is what the samples are there to show.
  beriberikix/zephyr-v86 ran `native_sim` inside v86's Linux, so its sockets
  went through Linux; kartben/zephyr-in-the-browser, like this port, keeps
  Zephyr's stack and moves frames.

**Time.** A relay's peers follow the wall clock, so an uplinked board is
paced and does not stop when nothing is scheduled, as an interactive one
does not, and its clock follows the wall clock to each deadline rather than
jumping there (D5b). A frame from the relay is stamped with the board's time when it
arrives, and one that arrives while the host waits out an idle period
raises `IRQ.ETH` at once. Such a run is not repeatable, and nothing that
needs repeatability depends on it: the pairs stay on their own clock.

**Addresses.** RootlessRelay's DHCP hands out `10.0.2.15` with gateway
`10.0.2.2`, as QEMU's user networking does. `dhcpv4_client` takes that and
runs as shipped. Most networking samples, though, set a static `192.0.2.1`
with `192.0.2.2` as gateway and DNS server, which kartben's bridge serves
for the same reason. RootlessRelay fixed its pool at `10.0.2.x` whatever
the gateway, and sent a DNS query addressed to the gateway out to the real
network. `upstream/rootlessrelay/0001` fixes both. With it,
`GATEWAY_IP=192.0.2.2 DHCP_START=1 DHCP_END=1` runs such samples
unmodified: `sockets/http_get` fetched `http://google.com` through it
from Node.

**Nothing is on by default.**
- **The page.** It offers an Uplink field only for a build marked
  `uplink` in `apps.json`. The field starts empty, `?uplink=` fills it for
  one visit, and what someone types is remembered in their browser. The
  page names no relay of its own. zephyr-v86 defaulted to a public one;
  sending visitors' traffic through a third party is a decision for whoever
  publishes the site, and this one has not made it.
- **Opening the link.** The Worker opens the socket itself, so frames never
  pass through the page. A relay that cannot be reached ends the run with
  a message rather than booting a board that waits for ever.
- **Frames.** Frames outside 14 to 1518 bytes are dropped both ways, and
  anything else the relay sends is ignored.
- **Chrome.** From an https page, Chrome may ask before letting the site
  reach a relay on the local machine.

**Inbound** is the relay's business. RootlessRelay has a reverse proxy
for it, and whether a board's server can be reached through it is not
checked yet. zephyr-v86 recorded its relays as outbound only.

CI starts RootlessRelay 0.6.0, pinned, on loopback, and runs the uplink
build through it in Node and in Chromium. What it checks is a DHCP lease,
which the relay answers itself, so the checks do not depend on the
internet.

### D8m. The host is the LAN

Most networking samples want a peer that is neither another board nor the
internet: the Linux host upstream expects at `192.0.2.2`, running a DHCP
server, a resolver, a web server, `tftpd`. So the host is that too. A board
built with the `wasm-ethernet` snippet can be plugged into the host's own
network (`host/lan.mjs`, `run.mjs --lan`, `lan` in `apps.json`). The page
plays the whole network, and nothing leaves it. The idea is
kartben/zephyr-in-the-browser's, whose page is its LAN. That repository
has no licence, so the idea is taken and none of the code.

**The stack is lwIP**, as tcpip.js compiles it to wasm (MIT, with lwIP
under BSD-3), vendored as the one file `host/web/vendor/tcpip.wasm`.
tcpip.js's own JavaScript is not used. It drives lwIP from a wall-clock
`setInterval` through async streams, and a LAN here has to keep the board's
virtual time and be driven one call at a time, so that a run on it is as
repeatable as any other. The module turned out to allow that without a
rebuild:
- **The clock.** lwIP reads nothing from outside but the clock, through
  the one WASI call it imports, `clock_time_get`. `lan.mjs` answers it with
  the board's time.
- **Nothing random.** lwIP has no random source in this build, so ports,
  sequence numbers and IP identifiers come from counters and the clock,
  and repeat.
- **All synchronous.** A frame goes in through `send_tap_interface`, and
  lwIP's answers, frames and TCP/UDP events come back through the module's
  imports during that same call.

**On the board's clock.** A frame the board sends reaches the LAN at the
wire's 100 µs, and the LAN answers at once in guest time. What it sends
back is a frame arriving 100 µs later, like one from a peer board. Its own
timers are events on the board's timeline: `advanceToNextDeadline`
considers the LAN's next one, on a 50 ms grid, alongside the board's own.
When the board reaches it, the LAN runs and may send something, and the
board sees only the frames. So a board on the LAN never runs out of things
that can happen, and its builds are endless. `check_site` runs each twice
and requires the same output, as it does for a pair.

**What it offers** (`host/lan_services.mjs`) is what those samples ask for:
- DHCP, offering `192.0.2.1`;
- DNS, on 53 and on 15353, answering every name with `192.0.2.2`, so the
  LAN is whichever server a sample looks up and no remote host needs
  inventing;
- SNTP, with time from 2026-01-01 plus the board's clock;
- TFTP, with `file1.bin` to read and room to write;
- HTTP on 80, answering `/` with a redirect, which is what `http_get`'s
  upstream test expects from google.com;
- a WebSocket echo on 9001, for `websocket_client`, which gives each
  message back whole. The handshake needs SHA-1, and a small synchronous
  one is written out in the file: Web Crypto's digest answers with a
  promise, and everything on the LAN happens within one call;
- CoAP over TCP on 5683 (RFC 8323), for `coap_client_tcp`: a CSM, pong for
  ping, `GET /test`, and closing on Release, as the RFC says a peer
  normally does;
- FTP on 21, passive mode only, which is all Zephyr's FTP client uses: any
  user and password, a small tree to list and read, and room to write that
  lasts for the run. Each run gets a new LAN, as it gets a new board, so a
  run on it stays repeatable;
- an MQTT 3.1.1 broker on 1883, for `mqtt_publisher`: publishes at every
  QoS with their acknowledgements, pings, and delivery to subscribers;
- an MQTT-SN gateway on UDP 10000, for `mqtt_sn_publisher`, with the same
  broker behind it: connect, register, subscribe, publish and ping;
- dialling a board's port at a stated time and asking for a path, for a
  sample that is a server;
- pinging the board at stated times, for a sample that watches what
  arrives (`promiscuous_mode`) or decides what may (`pkt_filter`).

Where it answers in words, it says it is the LAN. What it does, it logs,
on stderr under `run.mjs` and in the terminal on the page, each on a line of
its own and stamped with the time on the board's clock in Zephyr's own
format: `[lan 00:00:02.000,300] ping 192.0.2.1 seq 1: reply`. The stamp is
there because the order alone misleads. A board's log lines are printed by
its log thread a little after the time they carry, so the LAN's reply to a
ping at 2.000,300 can print before the board's line about receiving it at
2.000,100. A server sample does not print what it served, nor a filter what
it dropped, so `lan_expect` in `apps.json` checks the log for that
(`prometheus`, `pkt_filter`).

**The board's side.** Two samples asked the Ethernet driver for things it
had not claimed, and both are claims it can make by doing nothing:
- **Promiscuous mode** (`promiscuous_mode`): nothing in the driver filters,
  so every frame on the link already reaches the stack;
- **VLANs** (`vlan`): a frame goes either way as it is, so a tag the stack
  adds reaches the wire and one that arrives reaches the stack, and
  `FRAME_MAX` has room for it.

Each capability is claimed only when its option is on, so no other build
changes.

**Three things in tcpip.js's C glue** matter:
- **Received frames are never freed.** A frame given to lwIP is used in
  place (`PBUF_REF`) and may be kept, so it is never freed. That leaks
  about a byte of wasm memory per byte received, which a LAN's few
  kilobytes don't notice.
- **Received data comes from the first buffer only.** That is all there is
  while segments arrive in order, as they always do on this wire.
- **Sent frames were cut short.** A sent frame is handed over as its first
  buffer's payload with the whole chain's length. lwIP chains a buffer
  when a write joins a segment that has not gone yet, and such a frame went
  out with whatever followed the first buffer in memory. It failed its
  checksum, and failed again on every retransmission: an echo of 4 MB came
  back 2,256 bytes short, for ever.

  `Lan.frameAt` follows the chain instead. A buffer lwIP allocated keeps its
  `struct pbuf` just before the payload, so the struct is found there,
  believed only if its `payload` and `tot_len` fields are this frame's, and
  walked. `scripts/check_lan.mjs` puts 4 MB through an echo, checks every
  segment's checksum, and fails without the fix. The fix belongs in
  tcpip.js's `tap_interface_output`, and `upstream/README.md` says so.

**What it is not.**
- **IPv4 only.** lwIP was built without IPv6, so a sample's IPv6 half fails
  and says so (`sntp_client`, `websocket_client`).
- **Not a way round a bug.** Two of the samples these services are for do
  not count yet. `websocket_client` fails its own handshake at this
  workspace's Zephyr: the websocket library selects SHA-256 where it hashes
  with SHA-1, and upstream has since fixed it. `coap_client_tcp` waits for
  ever, because its client takes a request sent in the first millisecond
  of uptime for one never sent, and a board here connects in less
  (`upstream/zephyr/0013`). Each runs against the LAN with its fix, and
  counts when the pin moves or the fix lands.
- **No real traffic.** The LAN answers for the internet but never reaches
  it. That is D8l's job, and an entry with both runs on the LAN unless
  someone gives the page a relay.

### D8n. Semihosting is one import, and the files stay in the host

Semihosting is how an ARM, RISC-V or Xtensa target does I/O on the machine
debugging it: the target traps with an operation number and a pointer to its
arguments, and the debugger or QEMU opens, reads and writes files on its
behalf. Zephyr's CTF tracing writes its trace this way
(`tracing/pipeline`'s default backend), and `arch/common/semihost.c` already
builds every operation's argument block. All an architecture supplies is
`semihost_exec(op, args)`.

Here that is the `semihost` import (`arch/wasm/core/semihost.c`), which
needed nothing new in the guest beyond selecting `ARCH_HAS_SEMIHOST`. The
host implements the operations Zephyr uses (open, close, read, write, seek,
length, is-a-tty, and the console ones), with the ARM convention's results:
a read or write returns how many bytes it did *not* transfer, and `:tt` is
the console.

The files live in the host's memory, not on disk. A run that writes a trace
is then as repeatable as one that does not, both engines give the same
answer (`run_wasmtime.py` implements the same operations), stepping back
takes the files back too, and the page can do the same thing without a file
system. `run.mjs --semihost-dir <dir>` writes them out at the end. A
pipeline run's `tracing.bin` opens in upstream's own
`scripts/tracing/trace_viewer.py`: 10,466 events across ten threads for 3 s
of guest time.

The SoC also has three P-states (`performance-states` in the board's
devicetree, set by `soc/wasm/cpu_freq.c`), so the CPU frequency policies
run as they do on native_sim. There is no clock to slow: setting a state
records it. The policies, and the load measurement they choose by, are the
real ones.


### D8o. A safepoint publishes the frame of a function that makes no calls

LLVM's wasm backend gives a function that makes no calls a stack frame
without moving `__stack_pointer`: it reads the global, subtracts the frame
and works below it, since nothing it calls could need the space. The
safepoint pass breaks that assumption after the fact. A safepoint is a call,
and an interrupt taken there runs its handler on the same stack, from the
pointer the function never moved, right over its frame.

It showed once the UART took interrupts. The shell enables its TX interrupt
whenever it prints, so the handler runs at safepoints inside the formatting
code, and `net iface` printed `17.156.2.0` for `192.0.2.1`: the bytes
`0x00029c11`, a pointer into the shell's TX ring that the handler left
where a formatter kept its working copy. Any interrupt could have done it
before (timer, GPIO, Ethernet); none fired often enough inside such a
function to be seen.

The pass now looks at every function before it instruments any: one that
reads the stack pointer, takes a frame off it (`global.get`, `i32.const N`,
`i32.sub`) and never writes it has each of its safepoint calls wrapped in a
move of the pointer past the frame, rounded to 16, and back. What the
safepoint runs is stacked below the frame. A function that reads the pointer
without writing it in any other pattern stops the build, since guessing at
its frame would be guessing at what may be overwritten. In the builds here
the wrap applies to two or three functions each.

### D8p. A radio between two boards

Phase 7 is Bluetooth, and Zephyr's Bluetooth host talks to its controller
over HCI. Web Bluetooth is the wrong layer for that: it hands a page GATT,
the top of the stack, where Zephyr wants to be the stack. So the board gets
what boards with a separate controller chip have: a second UART, with
upstream's H4 driver on it, and at its other end a controller.

**The guest side is upstream's.** The `wasm-bt` snippet turns on
`host_uart1`, the board's second UART (port 1, line 6, 1 Mbaud), hangs a
`zephyr,bt-hci-uart` node off it and points `zephyr,bt-hci` at that, the
same shape as `qemu_x86`'s second serial port. `BT_H4` follows from the
devicetree. Nothing in the samples, the host stack or the driver changes.
Only the UART imports changed, to take a port.

**The controller is the host's** (`host/bt.mjs`), one per board, on that
board's clock as the LAN is (D8m). It reads H4 from the guest and answers as
a Bluetooth 5.0 controller with the legacy LE subset: what the host sends at
init, advertising, scanning, creating and cancelling a connection,
connection update, remote features and version, disconnect, and ACL data
with Number Of Completed Packets. Its features say no to encryption, data
length, privacy, 2M and extended advertising, so the host never asks for
them, and anything else is "Unknown HCI Command". Its public address comes
from the board's seed, as its MAC does: `C0:DE:00:00:00:01` for the first
board of a pair.

**The air is the pair's** (`host/pair.mjs`). Each controller hands what it
transmits to the pair, which delivers it to the other one a link latency
later and synchronises the two boards exactly as for an Ethernet frame
(D8k): the receiver is woken for it, and the sender may run no further than
an answer could come back. What goes over the air is the controller's own
PDUs, not bits:
- an advertiser sends its advertising PDU every advertising interval, with
  its scan response along, since the scan request and response are not
  modelled;
- a scanner reports each one it hears at RSSI -40 (several upstream
  centrals only connect at -50 or better), and for active scanning of a
  scannable advertiser, the scan response too;
- an initiator connects on the first connectable PDU from the address it
  wants: both sides report the connection at once, and the advertiser
  stops;
- on a connection, ACL data goes at the next connection event, every
  connection interval from the moment of connection, and the sender's
  packets are reported done when they go. Updates, remote features and
  disconnects take effect at the next event too.

A controller wakes its board only for what it has to do: an advertising
event, a connection event with something to send, a PDU arriving, or a byte
for the guest, which comes down the UART at its line rate as the console's
does (D10). An idle connection costs nothing. Nothing reads the wall clock
or an unseeded random number, so a Bluetooth pair repeats as an Ethernet
one does, and the Node check runs each twice and compares.

Encryption is the next thing it lacks: pairing needs LE Start Encryption and
the LTK exchange, which `central_gatt_write` and `central_multilink` ask for.
The same UART is also what a real controller would sit behind: Web Serial to
an HCI dongle replaces the far end, not the guest.

### D9. The link goes through the clang driver, which runs wasm-opt

The link is `clang -fuse-ld=wasm-ld` (`cmake/linker/wasm-ld/target.cmake`).
That is not the same as calling wasm-ld: when the link line carries an
optimisation level and `wasm-opt` is on the `PATH`, which it always is here
because Asyncify needs it, the driver runs `wasm-opt` at that level over the
linked module. That rewrites the code, so the link map, which describes
wasm-ld's output, has 530 functions in a build where the module has 326. It
also drops the name section.

The full Asyncify pass needs no names (D8), so this costs nothing at run
time, but it costs a lot in diagnosis: a trap says `wasm-function[116]` and
nothing names it. For a build that has to be read, add
`-DEXTRA_LDFLAGS=--no-wasm-opt`, which keeps wasm-ld's names in
`zephyr.elf` with the same function indices as `zephyr.wasm`. An earlier
version of this note said the link called wasm-ld directly so that names
survived. It did not, and nothing noticed until a trap needed naming.

### D10. The UART takes interrupts

It began polled, on the reasoning that nothing let the host interrupt the
guest. That stopped being true with the pending word: the host sets a bit
and the guest takes it at its next safepoint, and GPIO, input, sensors and
Ethernet all interrupt that way. The UART now does too
(`CONFIG_UART_INTERRUPT_DRIVEN`), on line 5. Zephyr's Bluetooth transport,
H4, needs it, which is why it came first in Phase 7.

There can be two. The imports take a port: 0 is the console, and 1, on line
6, is the HCI line a Bluetooth build hangs H4 off (D8p). Each port has its
own line rate from its devicetree node, 115200 baud for the console and
1 Mbaud for HCI, and the driver keeps its look-ahead and interrupt state per
instance.

Four things make a host UART look like one on a board:
- **A line rate.** Typed bytes come down the wire at the 115200 baud the
  devicetree gives the UART, a byte every 87 µs of guest time, however fast
  they were typed, pasted or piped. Without it, a paced board that had jumped
  ahead to its next timer while keys were being pressed received them all
  at once when it got there: 79 bytes in one interrupt, into the shell's
  64-byte ring, and the end of a command was lost. That was the zperf pair
  in the browser. The sender waits for the guest, as flow control would, so
  no byte is ever lost on the way in.
- **Arrival.** The host raises the line once for each byte that has come
  down the wire, rather than for as long as it waits, so a guest that never
  reads cannot be stormed. The next byte's time is a deadline like a frame's,
  so an idle board wakes for it.
- **A byte of look-ahead.** `uart_irq_rx_ready()` must say whether a byte is
  waiting without taking it, and the host's import only takes. The driver
  reads one ahead and keeps it, so the ABI did not change.
- **An empty transmitter.** The host takes every byte as it is written, so
  the transmit FIFO is always empty, and an enabled TX-empty interrupt fires
  at once and keeps firing, as on hardware. The driver raises its own line
  for that (`z_wasm_irq_raise()`), on enable and at the end of each ISR while
  transmit stays enabled, which is how upstream's `uart_emul` behaves too.

Once the UART can interrupt, Zephyr builds every shell interrupt-driven, as
on every real board (`SHELL_BACKEND_SERIAL_INTERRUPT_DRIVEN` defaults to y).
That changed how a script types into one. The polled shell read on a timer,
only as fast as its ring had room, and only once it had started. The
interrupt-driven one reads the moment bytes arrive: bytes queued at boot were
taken in before `shell_start()` flushed its input, which it does on purpose,
and a long burst overran its 64-byte ring. So the host types piped input as
twister's shell harness does: a line at a time, each once the shell has
printed its prompt since the last, or for a board with no shell, once it has
read the last line. Piped input is all there is, so the run is no longer
interactive and ends when the board falls quiet, where it used to wait for
keys that could not come. `run.mjs --type-at` holds typing until a board has
set up, for a check whose answer depends on it. It also showed a bug in the
safepoint pass that any interrupt could have hit (D8o).

Input also forced a change in the host early on. It reads stdin through
Node's event loop, which never got a turn because the Asyncify driver is a
synchronous loop. It yields whenever the guest idles, which is when input
can matter and never on a hot path.

### D11. The C library is picolibc, built from its module

Picolibc is Zephyr's default C library on every board whose toolchain can
build it, and it is this board's default too: the board chooses no libc, so
each build gets what Zephyr's `lib/libc/Kconfig` picks, as it would anywhere
else. No toolchain supplies a libc for wasm32 here, so picolibc is built from
source as a module, the route Zephyr already provides for toolchains without
their own. A build can still choose the minimal libc with
`CONFIG_MINIMAL_LIBC=y`.

It was not always the default. The board began by forcing the minimal libc,
when picolibc could not be built for wasm at all, and kept it after picolibc
could, for samples that did not ask for more. That made every result a
measure of a choice the board made and upstream does not: a sample that
built on every other board could fail here on something the minimal libc
lacks. The mDNS pair found one. The network shell calls `strcasecmp`, which
the minimal libc does not have, so `dns_resolve` could not compile.
`upstream/zephyr/0012` adds `strcasecmp` to the minimal libc for the boards
that choose it. This board now takes Zephyr's default instead, and every
record was re-measured against it (ROADMAP.md, "The measure").

What that took, each for a reason that would bite any wasm32 port:
- Clang defines `__BYTE_ORDER__` for wasm32 but not `__FLOAT_WORD_ORDER__`,
  and picolibc's `<machine/ieeefp.h>` has no wasm entry, so it cannot tell
  the float layout. The port defines the macro, twice: once through
  `zephyr_interface` for Zephyr's compiles and the offsets generator, and
  once as a toolchain flag for picolibc's own sources, which the module
  builds without `zephyr_interface`'s definitions.
- There is no compiler-rt for wasm32. Clang lowers 128-bit multiplies and
  shifts to calls, and picolibc's `strtoull` and float `printf` make them;
  its `strtod` widens a double to `long double`, which on wasm32 is
  binary128, through another. `arch/wasm/core/builtins.c` has the four
  that anything has needed so far, each tested against the host
  compiler's own 128-bit arithmetic.
- The common `malloc`'s default arena runs from the linker symbol `_end` to
  the end of RAM, and there is no linker script to define `_end`. The arch
  defaults to a 16 KB arena in BSS instead, which is native_sim's answer to
  the same absence.
- The wasm-ld link rule appends the libraries named in `link_order_library`,
  as lld's `toolchain_linker_finalize()` does, which is how picolibc's
  `libc.a` ends up on the line.
- Picolibc puts a destructor in `.fini_array`, which the wasm backend
  refuses outright. `patches/picolibc/0001` leaves it out on wasm. Zephyr
  never runs that array on any architecture.

Two more came from the samples that picolibc let through:
- **Constructors.** wasm-ld collects `.init_array` into
  `__wasm_call_ctors()`, and nothing called it, so no constructor had ever
  run on this port, in C or C++. The kernel walks
  `__zephyr_init_array_start` to `_end` from `z_static_init_gnu()`; the arch
  now defines that list as a single entry that calls `__wasm_call_ctors()`,
  ended by a NULL the kernel's loop already stops at. Constructors therefore
  run where they do on every other target.
- **Dynamic thread stacks.** `PTHREAD_STACK_MIN` is `K_KERNEL_STACK_LEN(0)`,
  which here is the Asyncify buffer every stack reserves, 4 KB. The kernel's
  default dynamic stack of 1024 bytes is below it, so `pthread_create()`
  refused every thread. The arch defaults `DYNAMIC_THREAD_STACK_SIZE` to the
  buffer size, as x86 raises it for its own reasons.

### D12. A sample may be given this board's files, as native_sim's are

Upstream describes what a sample needs on a particular board in that
sample's `boards/` directory: `boards/native_sim.overlay` declares the
devices it needs there, and `boards/native_sim.conf` sets the options that
board needs for it. Twister and the build apply them automatically when
building for that board, and nowhere else. On any other board the sample
finds only what the board's own devicetree has, so many samples that run
on native_sim are filtered out here, or build and find no device.

This board has the same: `boards/wasm/wasm_node/apps/<path>/wasm_node.overlay`
and `wasm_node.conf`, where `<path>` is the application's path under
`zephyr/`. `scripts/sweeplib.py` applies them the way Zephyr applies a
board's own: the overlay replaces the application's `app.overlay`, unless
the build names `DTC_OVERLAY_FILE` itself, and the conf file is merged after
`prj.conf` and before any `EXTRA_CONF_FILE`. Both sweeps and `stage_site.sh`
use it, so a sample is built the same way wherever it runs. If this board
were upstream, these would be `samples/<x>/boards/wasm_node.*`, unchanged.

The rule is the one native_sim's files follow: an overlay and a Kconfig
fragment, and nothing else. `sweeplib.board_files()` refuses any other file
in such a directory, so source cannot slip in. The sample record marks
every entry built with them (`"board_files": true`), and the page says so
under the entry's hint. What they contain so far:
- **Devices upstream emulates,** placed on the board's buses: a flow meter
  on `gpio0`, the biometrics emulator, an adt7420 thermometer on `i2c0`,
  the software video generator as `zephyr,camera`, and for `sensing/simple`
  a second bmi160 on an emulated SPI bus with the sample's sensing tree.
- **Power states** for `pm/latency`, as native_sim's overlay declares them.
  The sample brings its own PM hooks and selects `HAS_PM` itself, as on
  native_sim, whose SoC does not; the board's part was letting `wasm,cpu`
  include `cpu.yaml`, so a CPU can list `cpu-power-states`.
- **Immediate logging,** for the two samples whose timings assume it.
  native_sim logs immediately by default (`LOG_MODE_IMMEDIATE if
  ARCH_POSIX`). Deferred, `pm/latency`'s log thread wakes inside every
  sleep, so no power state's residency is met, and `sensing/simple` drops
  the line upstream checks for.

### D13. A full C++ library comes from a sysroot

Zephyr's own C++ support is a minimal library that provides `new`, `delete`
and little else. A sample that wants the standard library (`std::cout`,
containers, `<string>`) sets `CONFIG_REQUIRES_FULL_LIBCPP`, and on every
other architecture the Zephyr SDK answers it with a C++ library built
against the SDK's own picolibc. Zephyr insists on that pairing: with a full
C++ library, `PICOLIBC_SUPPORTED` no longer accepts the module and only the
toolchain's picolibc will do, because libc++ has to be compiled against the
C library it will be linked with. Nothing ships either for wasm32 and
picolibc. apt.llvm.org's wasm32 libc++ is built for WASI's C library, a
different ABI.

So `scripts/build_sysroot.sh` builds what the SDK would have, into
`wasm-sysroot/` beside the workspace (or `$WASM_SYSROOT`):
- **picolibc,** from the module checkout west already made, with the
  port's patches, configured as Zephyr configures the module for this board:
  no thread-local storage, `errno` through `z_errno_wrap`, Zephyr's own
  `malloc`, the same printf options.
- **libc++ and libc++abi,** from the LLVM release that matches CI's clang,
  after libc++'s own picolibc configuration: no threads, exceptions,
  filesystem, wide characters or random device, with RTTI. Zephyr builds
  C++ without exceptions on every target, and wasm has no threads.
- **compiler-rt's builtins,** because libc++ formats a `long double`, which
  on wasm32 is binary128, and that needs the soft-float routines. The port's
  own four (D11) are linked first and win where both have one.

The script stamps the result with the picolibc commit and diff, the LLVM
release and its own hash, and does nothing when the stamp matches. CI caches
it on the same inputs.

The toolchain declares `TOOLCHAIN_HAS_PICOLIBC` and `TOOLCHAIN_HAS_LIBCXX`
when the sysroot is there, as the SDK's does, and
`cmake/sysroot_wasm.cmake` adds its headers and libraries to builds that
choose the toolchain's picolibc. The C++ library is Zephyr's
`EXTERNAL_LIBCPP` rather than `LIBCXX_LIBCPP`, which also wants
`TOOLCHAIN_VARIANT_COMPILER` to say `llvm`; saying so here would change
other defaults, `SIZE_OPTIMIZATIONS` among them, for every build.

**C builds do not move.** Once the toolchain declares a picolibc, Zephyr
would default every build to it. The board's `Kconfig.defconfig` keeps the
module as the default unless a full C++ library is required, so only those
builds use the sysroot, and every existing build is unchanged. Without a
sysroot such a build stops at configure time and says to run the script.

Two things the sysroot needed that no C build had:
- picolibc's CMake build leaves out six `long double` sources its meson
  build compiles, `__fpclassifyl` among them, and libc++ calls it.
  `patches/picolibc/0002` adds them.
- libc++ takes newlib's ctype masks as `char`. wasm32's `char` is signed,
  so its regex table narrows a negative constant, which is an error in
  C++11. The script builds libc++ with `-Wno-c++11-narrowing`; the bits
  are the same once truncated back to `char`, which is how they are
  compared.

### D14. A trap is a CPU exception

On hardware, a call through a bad pointer, an integer division by zero or an
undefined instruction raises a CPU exception. Zephyr reports it
(`>>> ZEPHYR FATAL ERROR 0: CPU exception`) and calls
`k_sys_fatal_error_handler()`. The default handler halts the system; one
that returns, as tests and some applications provide, has the faulting
thread aborted and the rest carry on. In wasm the same faults are traps: a call through a bad
pointer or with the wrong signature (D8b), a division by zero, an
`unreachable`. A trap unwinds every wasm frame to the host, and the board
used to end there with a JavaScript stack trace.

It does not have to. A trap destroys the running thread's wasm frames and
nothing else: linear memory, and with it every kernel object, is as it was,
and so is `__stack_pointer`. The host already enters the guest through
exports and switches threads by unwinding into the outgoing thread's buffer.
So after a trap it enters again, at `z_wasm_trap()` on the trapped thread's
stack, and prints `*** trap: RuntimeError: <message> ***`. `z_wasm_trap()`
puts the nesting count back to thread level, since an interrupt handler's
frames are gone too, and calls `z_fatal_error(K_ERR_CPU_EXCEPTION)`. The
handler decides: by default the board halts, cleanly now (below), with the
reason on the console; a handler that returns has the kernel abort the
thread and switch away, which unwinds into the dead thread's buffer like
any other switch, and the rest of the board carries on.
Upstream's `tests/kernel/fatal/exception` now passes as it is: its CPU
exception cases are an illegal call and a division by zero.

What it does not cover, where the trap goes on up as before:
- a trap during boot, before there is a thread to abort;
- a trap mid-rewind or mid-unwind, where Asyncify's own state cannot be
  trusted;
- a trap inside `z_wasm_trap()` itself;
- more than 100 traps in a run, which says the guest is not recovering.

A guest that halts was ending in a trap too. The fatal import starts an
unwind, but `arch_system_halt()` never returns, so its callers are not
instrumented to resume (D8a) and the unwind ran into the `unreachable` after
the call. The host now recognises that trap as the halt it is and ends the
run cleanly, with the `*** fatal` line and exit code 1.

The sweep judges faults as twister does. Twister fails a run that reports
a fatal error unless upstream's entry sets `ignore_faults`, whatever else
matched, and `check_samples.py` now does the same. Without that, a sample
whose thread entry has the wrong signature could pass on the strength of its
other threads' output, with one thread dead.

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
number taken once. Of 26 suites, 23 pass outright, one finishes with
failures, and two do not finish. Each of the three has a known cause, and
none is the port's to fix:
- `device` fails exactly the four cases that exercise `DEVICE_API_IS()` on an
  extended class, which is patch 0007's documented approximation
  demonstrated rather than predicted.
- `mutex/mutex_api` and `pending` are D8b above: their thread entries have
  the wrong signature, and `upstream/zephyr/` has the fix. The trap is
  raised as a CPU exception (D14), and with no handler of their own the
  kernel's default halts the board, as it would anywhere.

Timing was blamed for four more, on the theory that a time slice ends at the
next safepoint rather than on the tick. It was not that. `common`,
`timer/timer_api`, `tickless/tickless_concept` and `sched/schedule_api` all
measure with `k_busy_wait()`, and the busy-wait was taking the kernel's alarm
(D8d, "A busy-wait takes interrupts"). `threads/thread_apis` trapped because
the fatal path could not return when the kernel needed it to
(`arch/wasm/core/fatal.c`).

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

**picolibc/0001-exitprocs-no-fini-array-on-wasm.patch** is to picolibc rather
than Zephyr, and `scripts/apply_patches.sh` applies it to that module. Clang's
wasm backend refuses the `.fini_array` entry picolibc uses to register its
`atexit()` runner; Zephyr never runs that array on any target, so the patch
leaves it out on wasm (D11).

**picolibc/0002-libm-build-every-long-double-source-with-CMake.patch** adds
six `long double` sources picolibc's CMake build left out and its meson build
does not. Only the sysroot's libc++ reaches them (D13).

**0009-twister-cases-from-output-when-not-elf.patch** lets twister run a ztest
suite on this board. It lists a suite's cases from the ztest symbols in the
image's ELF symbol table, and a WebAssembly image is not ELF, so the whole
run stopped there. With the patch it skips that step for an image that is
not ELF, and takes the cases from the console output its harness parses
anyway. `scripts/twister.sh` runs twister with the module and toolchain
arguments every build needs.

**0010-thread-info-stack-pointer-on-wasm.patch** adds wasm to the list in
`subsys/debug/thread_info.c` of where each architecture keeps a thread's
saved stack pointer, for `CONFIG_DEBUG_THREAD_INFO`. Without it the file
ends in a `#warning`, which twister's warnings-as-errors build refuses, so
`philosophers` did not build under twister.

**0008-cbprintf-cxx-long-double-check-on-wasm.patch** adds `__wasm__` to the
architectures on which cbprintf's C++ build skips its `long double` check.
That check is not a constant expression in C++, and wherever a `long double`
is aligned more strictly than a `double`, the assertion that uses it does
not compile. Zephyr already lists x86_64, riscv and aarch64 for the same
reason.
