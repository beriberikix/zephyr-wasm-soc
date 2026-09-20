/*
 * SPDX-License-Identifier: Apache-2.0
 */
#ifndef ZEPHYR_INCLUDE_ARCH_WASM_ARCH_INLINES_H_
#define ZEPHYR_INCLUDE_ARCH_WASM_ARCH_INLINES_H_

#ifndef _ASMLANGUAGE
#include <zephyr/kernel_structs.h>

static ALWAYS_INLINE _cpu_t *arch_curr_cpu(void)
{
	/* No SMP: there is exactly one linear memory and one instance. */
	return &_kernel.cpus[0];
}

static ALWAYS_INLINE uint32_t arch_proc_id(void)
{
	return 0;
}

static ALWAYS_INLINE unsigned int arch_num_cpus(void)
{
	return 1;
}

#endif /* _ASMLANGUAGE */
#endif /* ZEPHYR_INCLUDE_ARCH_WASM_ARCH_INLINES_H_ */
