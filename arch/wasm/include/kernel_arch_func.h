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

/* arch_thread_return_value_set is not defined here: under CONFIG_USE_SWITCH
 * the kernel provides it itself, in kernel_internal.h.
 */

static ALWAYS_INLINE bool arch_is_in_isr(void)
{
	return _kernel.cpus[0].nested != 0U;
}

/* No arch_switch_to_main_thread here. Zephyr declares it FUNC_NORETURN, and
 * Asyncify cannot suspend inside a function that never returns: the unwind
 * needs a point to resume into, and there is none past a call the compiler
 * has been told never comes back. The kernel's generic path, which goes
 * through arch_switch() from the dummy thread, works unchanged.
 */

#ifdef __cplusplus
}
#endif

#endif /* _ASMLANGUAGE */
#endif /* ZEPHYR_ARCH_WASM_INCLUDE_KERNEL_ARCH_FUNC_H_ */
