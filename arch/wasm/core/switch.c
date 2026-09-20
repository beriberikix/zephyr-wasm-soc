/*
 * Context switching.
 *
 * A wasm module cannot switch its own stack: Asyncify unwinds to the host, and
 * only the host can rewind a different one. So a switch is a request. The arch
 * describes both stacks in a block in linear memory, calls the host's
 * switch_to import, and the call returns only when this thread runs again.
 *
 * Everything Asyncify-specific is confined to this file and to the host
 * harness, so a stack-switching backend can replace it without the rest of the
 * arch noticing. See DESIGN.md D3.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

#include <zephyr/kernel.h>
#include <zephyr/kernel_structs.h>
#include <zephyr/arch/wasm/wasm_host.h>
#include <kernel_arch_func.h>

/* The host reads and writes this; it is the whole of the switch ABI. */
struct wasm_switch_block z_wasm_switch_block;

/* Exported so the host can find the block without knowing any struct layout. */
__attribute__((export_name("z_wasm_switch_block_addr")))
uint32_t z_wasm_switch_block_addr(void)
{
	return (uint32_t)(uintptr_t)&z_wasm_switch_block;
}

void z_wasm_switch(void *switch_to, void **switched_from)
{
	struct k_thread *to = (struct k_thread *)switch_to;
	/* switched_from points at the outgoing thread's switch_handle, which
	 * sits at a known offset inside that thread. Recover the thread from
	 * it the way the other USE_SWITCH ports do.
	 */
	struct k_thread *from = CONTAINER_OF(switched_from, struct k_thread, switch_handle);

	/* The interrupt lock is per-thread state, not global. A thread that
	 * blocks while holding it must not leave every other thread, and the
	 * idle loop in particular, running with interrupts masked: the
	 * dispatcher would never run and nothing would ever wake.
	 */
	from->arch.irq_lock_key = z_wasm_irq_masked;
	z_wasm_irq_masked = to->arch.irq_lock_key;

	z_wasm_switch_block.from_buf = from->callee_saved.asyncify_buf;
	z_wasm_switch_block.to_sp = to->callee_saved.sp;
	z_wasm_switch_block.to_buf = to->callee_saved.asyncify_buf;
	z_wasm_switch_block.to_fresh = to->callee_saved.fresh;
	z_wasm_switch_block.to_arg = (uint32_t)(uintptr_t)to;

	to->callee_saved.fresh = 0U;

	/* Publish the outgoing handle before suspending: once the host has
	 * unwound us, another thread may look at it.
	 */
	*switched_from = from;

	wasm_host_switch_to();   /* suspends here, resumes here */

	/* Back on this thread. The host restored __stack_pointer already. */
}
