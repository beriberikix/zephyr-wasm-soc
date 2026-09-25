/*
 * The zephyr_host ABI: everything the kernel asks of the host.
 * SPDX-License-Identifier: Apache-2.0
 */
#ifndef ZEPHYR_INCLUDE_ARCH_WASM_WASM_HOST_H_
#define ZEPHYR_INCLUDE_ARCH_WASM_WASM_HOST_H_

#include <stdint.h>

#define WASM_HOST_IMPORT(name) \
	__attribute__((import_module("zephyr_host"), import_name(#name)))

/* Console. The kernel hands over one byte at a time through the printk hook. */
WASM_HOST_IMPORT(console_write) void wasm_host_console_write(const char *buf, int32_t len);

/* Monotonic time in nanoseconds. Under virtual time this only advances when
 * the host decides it does, which is what makes runs reproducible.
 */
WASM_HOST_IMPORT(time_now_ns) int64_t wasm_host_time_now_ns(void);

/* Ask for a timer interrupt at an absolute deadline. A deadline in the past
 * means "as soon as possible".
 */
WASM_HOST_IMPORT(set_alarm_ns) void wasm_host_set_alarm_ns(int64_t deadline_ns);

/* Idle. A suspension point: the host unwinds the caller, advances virtual time
 * to the next deadline, and rewinds when something is pending.
 */
WASM_HOST_IMPORT(wait_for_event) void wasm_host_wait_for_event(void);

/* Context switch. A suspension point: the host unwinds the calling thread and
 * rewinds the one named in the switch block.
 */
WASM_HOST_IMPORT(switch_to) void wasm_host_switch_to(void);

/* UART. Output goes out a byte at a time; input returns the next byte waiting,
 * or -1 when there is none. Polling only: there is no way for the host to
 * interrupt the guest, so a receive interrupt would have nothing to fire it.
 */
WASM_HOST_IMPORT(uart_poll_out) void wasm_host_uart_poll_out(int32_t c);
WASM_HOST_IMPORT(uart_poll_in) int32_t wasm_host_uart_poll_in(void);

/* GPIO, as the host sees it.
 *
 * The pins themselves live in Zephyr's own emulated GPIO controller, which
 * knows about direction, pull, edges and callbacks. These two imports are the
 * whole of what crosses to the host: what the outputs are now, and what the
 * inputs are now. A page draws the first and drives the second.
 *
 * gpio_out is called whenever an output changes, which the bridge learns
 * through an ordinary GPIO callback. gpio_in is read when the host raises
 * WASM_IRQ_GPIO to say an input moved; see wasm_irq_lines.h. Neither is a
 * suspension point, so neither goes in the Asyncify import list.
 *
 * Levels are physical, not logical: bit N is the voltage on pin N, so an
 * active-low button reads 1 when it is not pressed.
 */
WASM_HOST_IMPORT(gpio_out) void wasm_host_gpio_out(int32_t port, uint32_t values);
WASM_HOST_IMPORT(gpio_in) uint32_t wasm_host_gpio_in(int32_t port);

/* Entropy. Fills the buffer; cannot fail.
 *
 * What it fills it with is host policy rather than ABI. Both hosts use the
 * same seeded generator by default, because CI requires two runs of a build
 * to be byte-identical and a real random source would end that. A flag opts
 * into the platform's own randomness for anyone who wants it.
 *
 * Not a suspension point.
 */
WASM_HOST_IMPORT(entropy_get) void wasm_host_entropy_get(uint8_t *buf, int32_t len);

/* Progress report from a safepoint.
 *
 * Under virtual time the clock only moves when the kernel idles, so a thread
 * that spins without calling into the kernel freezes time and can never be
 * preempted: the host has no opportunity to raise the timer interrupt. This
 * import gives it one. Safepoints call it every so often, and the host
 * advances virtual time and raises any deadline that has passed.
 *
 * Not a suspension point: it returns immediately, and whatever it makes
 * pending is taken at the next safepoint.
 */
WASM_HOST_IMPORT(safepoint_tick) void wasm_host_safepoint_tick(void);

/* Unrecoverable error. The host prints a diagnosis and stops the instance.
 * This is an import rather than a trap because a trap gives the host nothing
 * to report and no way back in.
 */
WASM_HOST_IMPORT(fatal) void wasm_host_fatal(int32_t reason, int32_t arg);

/* Storage. The guest names a region of its own memory -- the simulated
 * flash -- and the host may fill it from a saved image during this call.
 * The host reads it back whenever the guest is paused, so neither this nor
 * anything else about storage suspends.
 */
WASM_HOST_IMPORT(storage_attach) void wasm_host_storage_attach(void *buf, int32_t len);

/* A warm reboot: the host starts a new instance of the same module, keeping
 * the attached storage, as hardware keeps its flash across a reset. Does not
 * return.
 */
WASM_HOST_IMPORT(reboot) void wasm_host_reboot(int32_t type);

/* Display. The framebuffer is guest memory: attach names it once, flush
 * reports a rectangle just written, and the host reads the pixels whenever
 * the guest is not running. format is the Zephyr display_pixel_format.
 */
WASM_HOST_IMPORT(display_attach) void wasm_host_display_attach(void *fb, int32_t width,
								int32_t height, int32_t format);
WASM_HOST_IMPORT(display_flush) void wasm_host_display_flush(int32_t x, int32_t y,
							      int32_t width, int32_t height);
WASM_HOST_IMPORT(display_blank) void wasm_host_display_blank(int32_t on);

/* Input. The host queues pointer and key events and raises WASM_IRQ_INPUT;
 * the driver's ISR takes one sample, through the event with sync, per
 * interrupt, and the host raises the line again while it has more. Each call
 * writes one event -- type, code, value and sync, as input_report() takes
 * them -- into ev[4] and returns 1, or returns 0 when the queue is empty.
 */
WASM_HOST_IMPORT(input_poll) int32_t wasm_host_input_poll(int32_t *ev);

/*
 * What the host is told about a thread.
 *
 * The host is deliberately ignorant of Zephyr's struct layout -- it reads
 * linear memory and a handful of exported addresses and nothing else -- and
 * that is worth keeping, because a host that knew the offsets would go wrong
 * quietly whenever a struct moved. So inspection does not hand over offsets;
 * it hands over this, which the guest fills in and both sides agree on.
 *
 * Laid out for a host reading it as a Uint32Array: every field is four bytes
 * and the array is a plain stride. Adding a field means adding it here and
 * in the host's reader, which is the usual cost of an ABI.
 */
struct wasm_thread_info {
	uint32_t thread;      /* the k_thread *, as an identifier */
	uint32_t state;       /* _THREAD_* bits, as the kernel holds them */
	uint32_t is_current;  /* 1 for the thread holding the CPU */
	uint32_t name;        /* pointer to a NUL-terminated name, or 0 */
	int32_t prio;
	uint32_t stack_base;
	uint32_t stack_size;
	uint32_t sp;          /* the saved shadow-stack pointer */
	uint32_t asyncify_buf;
};

/*
 * The switch request block.
 *
 * Switching cannot happen inside the module: Asyncify unwinds to the host, and
 * only the host can rewind a different stack. So the arch fills this block and
 * calls switch_to(), and the host reads the block to know which stacks to swap.
 *
 * Passing it as a struct in linear memory, rather than as call arguments, keeps
 * the host from needing to know any Zephyr struct offsets.
 */
struct wasm_switch_block {
	uint32_t from_sp;     /* outgoing shadow stack pointer, written by the host */
	uint32_t from_buf;    /* outgoing Asyncify buffer */
	uint32_t to_sp;       /* incoming shadow stack pointer */
	uint32_t to_buf;      /* incoming Asyncify buffer */
	uint32_t to_fresh;    /* non-zero if the incoming thread has never run */
	uint32_t to_arg;      /* thread pointer, passed to the entry trampoline */
};

extern struct wasm_switch_block z_wasm_switch_block;

/* Set by the host when an interrupt is raised, cleared by the dispatcher.
 * Checked at safepoints rather than delivered asynchronously.
 */
extern volatile uint32_t z_wasm_irq_pending;
extern volatile uint32_t z_wasm_irq_masked;

#endif /* ZEPHYR_INCLUDE_ARCH_WASM_WASM_HOST_H_ */
