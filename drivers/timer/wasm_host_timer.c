/*
 * System timer over the host's clock imports.
 *
 * The host owns time. Under virtual time it only advances when the kernel
 * idles, jumping straight to the next deadline, which is what makes two runs
 * byte-identical.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

#include <zephyr/kernel.h>
#include <zephyr/init.h>
#include <zephyr/irq.h>
#include <zephyr/drivers/timer/system_timer.h>
#include <zephyr/sys_clock.h>
#include <zephyr/arch/wasm/wasm_host.h>

#define NSEC_PER_TICK (NSEC_PER_SEC / CONFIG_SYS_CLOCK_TICKS_PER_SEC)
#define TIMER_IRQ     0

static int64_t last_announced_ns;

static inline int64_t now_ns(void)
{
	return wasm_host_time_now_ns();
}

static void timer_isr(const void *arg)
{
	ARG_UNUSED(arg);

	int64_t now = now_ns();
	int64_t elapsed = now - last_announced_ns;
	int32_t ticks = (int32_t)(elapsed / NSEC_PER_TICK);

	if (ticks > 0) {
		last_announced_ns += (int64_t)ticks * NSEC_PER_TICK;
		sys_clock_announce(ticks);
	}
}

void sys_clock_set_timeout(int32_t ticks, bool idle)
{
	ARG_UNUSED(idle);

	if (ticks == K_TICKS_FOREVER) {
		/* Nothing to wake for. Leaving no alarm set is what lets the
		 * host decide the run is over.
		 */
		wasm_host_set_alarm_ns(INT64_MAX);
		return;
	}

	if (ticks < 1) {
		ticks = 1;
	}

	wasm_host_set_alarm_ns(last_announced_ns + (int64_t)ticks * NSEC_PER_TICK);
}

uint32_t sys_clock_elapsed(void)
{
	int64_t delta = now_ns() - last_announced_ns;

	if (delta < 0) {
		return 0;
	}
	return (uint32_t)(delta / NSEC_PER_TICK);
}

uint32_t sys_clock_cycle_get_32(void)
{
	return (uint32_t)(now_ns() / (NSEC_PER_SEC / CONFIG_SYS_CLOCK_HW_CYCLES_PER_SEC));
}

uint64_t sys_clock_cycle_get_64(void)
{
	return (uint64_t)(now_ns() / (NSEC_PER_SEC / CONFIG_SYS_CLOCK_HW_CYCLES_PER_SEC));
}

static int wasm_host_timer_init(void)
{
	last_announced_ns = now_ns();
	IRQ_CONNECT(TIMER_IRQ, 0, timer_isr, NULL, 0);
	irq_enable(TIMER_IRQ);
	return 0;
}

SYS_INIT(wasm_host_timer_init, PRE_KERNEL_2, CONFIG_KERNEL_INIT_PRIORITY_DEFAULT);
