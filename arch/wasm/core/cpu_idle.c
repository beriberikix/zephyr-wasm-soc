/*
 * Idle, and the safepoint where pending interrupts are noticed.
 * SPDX-License-Identifier: Apache-2.0
 */

#include <zephyr/kernel.h>
#include <zephyr/arch/wasm/wasm_host.h>
#include <kernel_arch_func.h>

void z_wasm_irq_dispatch(void);

void arch_cpu_idle(void)
{
	/* Check before suspending: an interrupt may already be waiting, and
	 * the host has no way to interrupt us once we are running.
	 */
	z_wasm_irq_masked = 0U;
	if (z_wasm_irq_pending != 0U) {
		z_wasm_irq_dispatch();
		return;
	}

	/* A suspension point. Under virtual time the host jumps straight to
	 * the next deadline rather than waiting.
	 */
	wasm_host_wait_for_event();

	if (z_wasm_irq_pending != 0U) {
		z_wasm_irq_dispatch();
	}
}

void arch_cpu_atomic_idle(unsigned int key)
{
	z_wasm_irq_masked = 0U;
	if (z_wasm_irq_pending != 0U) {
		z_wasm_irq_dispatch();
	} else {
		wasm_host_wait_for_event();
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
