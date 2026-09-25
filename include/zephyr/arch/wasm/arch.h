/*
 * WebAssembly architecture interface.
 * SPDX-License-Identifier: Apache-2.0
 */
#ifndef ZEPHYR_INCLUDE_ARCH_WASM_ARCH_H_
#define ZEPHYR_INCLUDE_ARCH_WASM_ARCH_H_

/* Every in-tree architecture's arch.h includes this, and Zephyr code relies
 * on getting the devicetree macros that way: ext2's fstab support, for one,
 * never includes it itself. */
#include <zephyr/devicetree.h>
#include <zephyr/arch/wasm/thread.h>
#include <zephyr/arch/wasm/exception.h>
#include <zephyr/arch/wasm/irq.h>
#include <zephyr/arch/common/sys_bitops.h>
#include <zephyr/arch/common/sys_io.h>
#include <zephyr/arch/common/ffs.h>
#include <zephyr/sys/util.h>

#ifndef _ASMLANGUAGE
#include <zephyr/arch/wasm/wasm_host.h>
#include <zephyr/toolchain.h>
#include <zephyr/irq.h>

#ifdef __cplusplus
extern "C" {
#endif

/* wasm32 keeps the shadow stack 16-byte aligned, as the C ABI requires. */
#define ARCH_STACK_PTR_ALIGN 16

/*
 * Every thread stack object carries its Asyncify buffer in the high part, so
 * the reserved amount comes straight out of the usable stack.
 */
#define ARCH_THREAD_STACK_RESERVED (CONFIG_WASM_ASYNCIFY_BUFFER_SIZE)

/* Kernel stacks need the same reservation. The idle thread and the system
 * work queue run on K_KERNEL_STACK objects, and they suspend exactly like any
 * other thread, so without this their Asyncify buffers would be written into
 * whatever memory happens to follow the stack.
 */
#define ARCH_KERNEL_STACK_RESERVED (CONFIG_WASM_ASYNCIFY_BUFFER_SIZE)

#define ARCH_EXCEPT_REASON_OFFSET 0

static ALWAYS_INLINE unsigned int arch_irq_lock(void)
{
	unsigned int key = z_wasm_irq_masked;

	z_wasm_irq_masked = 1U;
	return key;
}

static ALWAYS_INLINE void arch_irq_unlock(unsigned int key)
{
	z_wasm_irq_masked = key;
}

static ALWAYS_INLINE bool arch_irq_unlocked(unsigned int key)
{
	return key == 0U;
}

static ALWAYS_INLINE bool arch_cpu_irqs_are_enabled(void)
{
	return z_wasm_irq_masked == 0U;
}

static ALWAYS_INLINE void arch_nop(void)
{
	/* Nothing to emit: wasm has no nop worth keeping. */
}

extern uint32_t sys_clock_cycle_get_32(void);

static inline uint32_t arch_k_cycle_get_32(void)
{
	return sys_clock_cycle_get_32();
}

extern uint64_t sys_clock_cycle_get_64(void);

static inline uint64_t arch_k_cycle_get_64(void)
{
	return sys_clock_cycle_get_64();
}

#ifdef __cplusplus
}
#endif

#endif /* _ASMLANGUAGE */
#endif /* ZEPHYR_INCLUDE_ARCH_WASM_ARCH_H_ */
