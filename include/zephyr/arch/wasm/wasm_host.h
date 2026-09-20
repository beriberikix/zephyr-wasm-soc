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

/* Unrecoverable error. The host prints a diagnosis and stops the instance.
 * This is an import rather than a trap because a trap gives the host nothing
 * to report and no way back in.
 */
WASM_HOST_IMPORT(fatal) void wasm_host_fatal(int32_t reason, int32_t arg);

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
