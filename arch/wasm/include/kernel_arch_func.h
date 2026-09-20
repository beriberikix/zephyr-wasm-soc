/*
 * SPDX-License-Identifier: Apache-2.0
 */
#ifndef ZEPHYR_ARCH_WASM_INCLUDE_KERNEL_ARCH_FUNC_H_
#define ZEPHYR_ARCH_WASM_INCLUDE_KERNEL_ARCH_FUNC_H_

#include <kernel_arch_data.h>
#include <zephyr/arch/wasm/wasm_host.h>

#ifndef _ASMLANGUAGE

#ifdef __cplusplus
extern "C" {
#endif

void z_wasm_switch(void *switch_to, void **switched_from);

static ALWAYS_INLINE void arch_kernel_init(void)
{
	z_wasm_irq_masked = 1U;
}

static ALWAYS_INLINE void arch_switch(void *switch_to, void **switched_from)
{
	z_wasm_switch(switch_to, switched_from);
}

static ALWAYS_INLINE void arch_thread_return_value_set(struct k_thread *thread,
						       unsigned int value)
{
	thread->arch.irq_lock_key = value;
}

static ALWAYS_INLINE bool arch_is_in_isr(void)
{
	return _kernel.cpus[0].nested != 0U;
}

FUNC_NORETURN void z_wasm_switch_to_main_thread(struct k_thread *main_thread,
						char *stack_ptr,
						k_thread_entry_t entry);

#define arch_switch_to_main_thread z_wasm_switch_to_main_thread

#ifdef __cplusplus
}
#endif

#endif /* _ASMLANGUAGE */
#endif /* ZEPHYR_ARCH_WASM_INCLUDE_KERNEL_ARCH_FUNC_H_ */
