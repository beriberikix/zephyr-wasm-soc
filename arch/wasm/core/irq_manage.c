/*
 * Cooperative interrupts.
 *
 * There is no interrupt controller and nothing preempts the running code. The
 * host raises an interrupt by setting a bit in a word in linear memory; the
 * kernel notices it at a safepoint and runs the handler itself. Masking is
 * just a second word, so arch_irq_lock() costs a store.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

#include <zephyr/kernel.h>
#include <zephyr/kernel_structs.h>
#include <zephyr/arch/wasm/wasm_host.h>
#include <kernel_arch_func.h>
#include <zephyr/sw_isr_table.h>
#include <zephyr/irq_offload.h>
#include <ksched.h>

volatile uint32_t z_wasm_irq_pending;
volatile uint32_t z_wasm_irq_masked = 1U;

static struct _isr_table_entry isr_table[CONFIG_WASM_IRQ_LINES];
static volatile uint32_t irq_enabled_mask;

/* Exported so the host can watch the mask while debugging a stuck idle. */
__attribute__((export_name("z_wasm_irq_masked_addr")))
uint32_t z_wasm_irq_masked_addr(void)
{
	return (uint32_t)(uintptr_t)&z_wasm_irq_masked;
}

__attribute__((export_name("z_wasm_irq_enabled_addr")))
uint32_t z_wasm_irq_enabled_addr(void)
{
	return (uint32_t)(uintptr_t)&irq_enabled_mask;
}

/* The host needs the addresses of these two words and nothing else. */
__attribute__((export_name("z_wasm_irq_pending_addr")))
uint32_t z_wasm_irq_pending_addr(void)
{
	return (uint32_t)(uintptr_t)&z_wasm_irq_pending;
}

int z_wasm_irq_connect_dynamic(unsigned int irq, unsigned int priority,
			       void (*routine)(const void *), const void *parameter,
			       uint32_t flags)
{
	ARG_UNUSED(priority);
	ARG_UNUSED(flags);

	if (irq >= CONFIG_WASM_IRQ_LINES) {
		return -EINVAL;
	}

	isr_table[irq].isr = routine;
	isr_table[irq].arg = parameter;
	return (int)irq;
}

void z_wasm_irq_enable(unsigned int irq)
{
	if (irq < CONFIG_WASM_IRQ_LINES) {
		irq_enabled_mask |= BIT(irq);
	}
}

void z_wasm_irq_disable(unsigned int irq)
{
	if (irq < CONFIG_WASM_IRQ_LINES) {
		irq_enabled_mask &= ~BIT(irq);
	}
}

int z_wasm_irq_is_enabled(unsigned int irq)
{
	return (irq < CONFIG_WASM_IRQ_LINES) && ((irq_enabled_mask & BIT(irq)) != 0U);
}

/*
 * Run every pending, enabled handler. Called from safepoints, never from the
 * host directly: the host only sets the word.
 */
void z_wasm_irq_dispatch(void)
{
	if (z_wasm_irq_masked != 0U) {
		return;
	}

	for (;;) {
		uint32_t active = z_wasm_irq_pending & irq_enabled_mask;

		if (active == 0U) {
			break;
		}

		unsigned int irq = (unsigned int)__builtin_ctz(active);

		z_wasm_irq_pending &= ~BIT(irq);

		_kernel.cpus[0].nested++;
		if (isr_table[irq].isr != NULL) {
			isr_table[irq].isr(isr_table[irq].arg);
		}
		_kernel.cpus[0].nested--;
	}
}

#ifdef CONFIG_IRQ_OFFLOAD
/*
 * Run a function in interrupt context. There is no way to raise a real
 * interrupt here, and none is needed: interrupts are delivered by calling
 * handlers from a safepoint anyway, so running the routine with the nesting
 * count raised is the same thing the dispatcher does.
 */
void arch_irq_offload(irq_offload_routine_t routine, const void *parameter)
{
	unsigned int key = arch_irq_lock();

	_kernel.cpus[0].nested++;
	routine(parameter);
	_kernel.cpus[0].nested--;
	arch_irq_unlock(key);

	/* Leaving an interrupt is a reschedule point on hardware. */
	z_reschedule_unlocked();
}

void arch_irq_offload_init(void)
{
}
#endif /* CONFIG_IRQ_OFFLOAD */
