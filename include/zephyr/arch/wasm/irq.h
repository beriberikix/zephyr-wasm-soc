/*
 * SPDX-License-Identifier: Apache-2.0
 */
#ifndef ZEPHYR_INCLUDE_ARCH_WASM_IRQ_H_
#define ZEPHYR_INCLUDE_ARCH_WASM_IRQ_H_

#ifndef _ASMLANGUAGE
#include <zephyr/toolchain.h>
#include <zephyr/types.h>

void z_wasm_irq_enable(unsigned int irq);
void z_wasm_irq_disable(unsigned int irq);
int z_wasm_irq_is_enabled(unsigned int irq);

#define arch_irq_enable(irq)     z_wasm_irq_enable(irq)
#define arch_irq_disable(irq)    z_wasm_irq_disable(irq)
#define arch_irq_is_enabled(irq) z_wasm_irq_is_enabled(irq)

/*
 * There is no static vector table. Every interrupt is registered at runtime
 * into a software table, which is why CONFIG_DYNAMIC_INTERRUPTS is on and
 * CONFIG_GEN_ISR_TABLES is off: the table generator reads a linked ELF.
 */
extern int z_wasm_irq_connect_dynamic(unsigned int irq, unsigned int priority,
				      void (*routine)(const void *), const void *parameter,
				      uint32_t flags);

#define ARCH_IRQ_CONNECT(irq_p, priority_p, isr_p, isr_param_p, flags_p) \
	z_wasm_irq_connect_dynamic(irq_p, priority_p,                    \
				   (void (*)(const void *))isr_p,        \
				   (const void *)isr_param_p, flags_p)

#endif /* _ASMLANGUAGE */
#endif /* ZEPHYR_INCLUDE_ARCH_WASM_IRQ_H_ */
