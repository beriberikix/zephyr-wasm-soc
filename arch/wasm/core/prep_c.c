/*
 * Boot path: the host calls z_wasm_boot(), which hands over to z_cstart().
 * SPDX-License-Identifier: Apache-2.0
 */

#include <zephyr/kernel.h>
#include <zephyr/kernel_structs.h>
#include <zephyr/arch/wasm/wasm_host.h>
#include <kernel_arch_func.h>
#include <kernel_internal.h>

extern FUNC_NORETURN void z_cstart(void);
extern void z_wasm_init_sections(void);

/*
 * The kernel boots on a dummy thread that owns no stack object, so when it
 * switches to main there is no Asyncify buffer to unwind into. Nothing needs
 * to be saved, but Asyncify still writes while it unwinds, so it needs
 * somewhere valid to write. This is that somewhere, used exactly once.
 */
static uint8_t boot_scratch[CONFIG_WASM_ASYNCIFY_BUFFER_SIZE]
	__attribute__((aligned(8)));

__attribute__((export_name("z_wasm_boot_scratch_addr")))
uint32_t z_wasm_boot_scratch_addr(void)
{
	uint32_t *hdr = (uint32_t *)boot_scratch;

	hdr[0] = (uint32_t)(uintptr_t)(boot_scratch + 8);
	hdr[1] = (uint32_t)(uintptr_t)(boot_scratch + sizeof(boot_scratch));
	return (uint32_t)(uintptr_t)boot_scratch;
}

/*
 * The module's entry point. There is no reset vector and no .bss to clear:
 * wasm zeroes its own linear memory, and data segments are placed by the
 * engine before the first call.
 */
__attribute__((export_name("z_wasm_boot")))
void z_wasm_boot(void)
{
	/* Fills the init-entry arrays that stand in for what a linker script
	 * would have placed. Must run before anything walks them.
	 */
	z_wasm_init_sections();

	z_cstart();
	CODE_UNREACHABLE;
}

/*
 * ARCH_HAS_CUSTOM_SWAP_TO_MAIN: the dummy thread the kernel boots on has no
 * Asyncify state to save, so switching away from it is a one-way trip rather
 * than a swap. Hand the host a fresh-thread start instead.
 */
FUNC_NORETURN void z_wasm_switch_to_main_thread(struct k_thread *main_thread,
						char *stack_ptr, k_thread_entry_t entry)
{
	ARG_UNUSED(stack_ptr);
	ARG_UNUSED(entry);

	/* Unwinding the dummy thread has nowhere real to go; the host points
	 * this at the boot scratch buffer and throws the result away.
	 */
	z_wasm_switch_block.from_buf = 0U;
	z_wasm_switch_block.to_sp = main_thread->callee_saved.sp;
	z_wasm_switch_block.to_buf = main_thread->callee_saved.asyncify_buf;
	z_wasm_switch_block.to_fresh = 1U;
	z_wasm_switch_block.to_arg = (uint32_t)(uintptr_t)main_thread;
	main_thread->callee_saved.fresh = 0U;

	wasm_host_switch_to();
	CODE_UNREACHABLE;
}
