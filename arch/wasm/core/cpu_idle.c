/*
 * Idle, and the safepoint where pending interrupts are noticed.
 * SPDX-License-Identifier: Apache-2.0
 */

#include <zephyr/kernel.h>
#include <zephyr/arch/wasm/wasm_host.h>
#include <kernel_arch_func.h>
#include <ksched.h>
#include <zephyr/tracing/tracing.h>

void z_wasm_irq_dispatch(void);

/* The idle notifications every architecture gives tracing and CPU load,
 * around the point where the CPU would sleep. Here that is the host wait.
 */
static inline void idle_enter(void)
{
#if defined(CONFIG_SYS_IDLE_HOOKS)
	sys_trace_idle();
#endif
}

static inline void idle_exit(void)
{
#if defined(CONFIG_SYS_IDLE_HOOKS)
	sys_trace_idle_exit();
#endif
}

void arch_cpu_idle(void)
{
	idle_enter();

	/* Check before suspending: an interrupt may already be waiting, and
	 * the host has no way to interrupt us once we are running.
	 */
	z_wasm_irq_masked = 0U;
	if (z_wasm_irq_pending != 0U) {
		idle_exit();
		z_wasm_irq_dispatch();
		return;
	}

	/* A suspension point. Under virtual time the host jumps straight to
	 * the next deadline rather than waiting.
	 */
	wasm_host_wait_for_event();
	idle_exit();

	if (z_wasm_irq_pending != 0U) {
		z_wasm_irq_dispatch();
	}

	/* On hardware, returning from an interrupt is itself a reschedule
	 * point. Here the dispatcher is an ordinary call, and anything it made
	 * ready was deferred because arch_is_in_isr() was true while it ran.
	 * Give the scheduler the chance it would otherwise have had.
	 */
	z_reschedule_unlocked();
}

void arch_cpu_atomic_idle(unsigned int key)
{
	idle_enter();
	z_wasm_irq_masked = 0U;
	if (z_wasm_irq_pending != 0U) {
		idle_exit();
		z_wasm_irq_dispatch();
	} else {
		wasm_host_wait_for_event();
		idle_exit();
		if (z_wasm_irq_pending != 0U) {
			z_wasm_irq_dispatch();
		}
	}
	z_wasm_irq_masked = key;
}

void arch_busy_wait(uint32_t usec_to_wait)
{
	/* Busy waiting against virtual time would never finish, because
	 * virtual time only advances when the host is idle. Ask the host to
	 * advance instead.
	 */
	int64_t deadline = wasm_host_time_now_ns() + (int64_t)usec_to_wait * 1000;

	while (wasm_host_time_now_ns() < deadline) {
		wasm_host_set_alarm_ns(deadline);
		wasm_host_wait_for_event();
	}
}
