/*
 * Thread creation.
 * SPDX-License-Identifier: Apache-2.0
 */

#include <zephyr/kernel.h>
#include <zephyr/kernel_structs.h>
#include <zephyr/arch/wasm/wasm_host.h>
#include <kernel_arch_func.h>
#include <kernel_internal.h>

/*
 * Entry trampoline. The host calls this to start a thread that has never run,
 * because a fresh thread has no Asyncify state to rewind.
 */
__attribute__((export_name("z_wasm_thread_entry")))
void z_wasm_thread_entry(uint32_t thread_addr)
{
	struct k_thread *thread = (struct k_thread *)(uintptr_t)thread_addr;

	z_thread_entry((k_thread_entry_t)thread->arch.entry, thread->arch.arg1,
		       thread->arch.arg2, thread->arch.arg3);
}

void arch_new_thread(struct k_thread *thread, k_thread_stack_t *stack,
		     char *stack_ptr, k_thread_entry_t entry,
		     void *p1, void *p2, void *p3)
{
	/*
	 * Split the stack object. K_THREAD_STACK already reserved
	 * ARCH_THREAD_STACK_RESERVED bytes, so stack_ptr is the top of the
	 * usable shadow stack and the Asyncify buffer sits just above it.
	 *
	 * Asyncify wants a two-word header at the front of its buffer: the
	 * current cursor and the end. It never bounds-checks that end, so the
	 * buffer has to be big enough for the deepest stack this thread can
	 * reach (DESIGN.md D8).
	 */
	uintptr_t buf = (uintptr_t)stack_ptr;
	uintptr_t end = buf + CONFIG_WASM_ASYNCIFY_BUFFER_SIZE;
	uint32_t *hdr = (uint32_t *)buf;

	hdr[0] = (uint32_t)(buf + 8);   /* cursor starts past the header */
	hdr[1] = (uint32_t)end;

	thread->callee_saved.sp = (uint32_t)(uintptr_t)stack_ptr;
	thread->callee_saved.asyncify_buf = (uint32_t)buf;
	thread->callee_saved.asyncify_end = (uint32_t)end;
	thread->callee_saved.fresh = 1U;
	thread->arch.irq_lock_key = 0U;
	thread->arch.entry = (void (*)(void *, void *, void *))entry;
	thread->arch.arg1 = p1;
	thread->arch.arg2 = p2;
	thread->arch.arg3 = p3;

	/* USE_SWITCH: the handle is the thread itself, published once the
	 * thread is ready to be switched to.
	 */
	thread->switch_handle = thread;
}

/*
 * No coprocessors, no lazy FPU state: wasm locals are saved by Asyncify along
 * with everything else. The kernel calls this on every abort, so it has to
 * exist even though it has nothing to do.
 */
int arch_coprocessors_disable(struct k_thread *thread)
{
	ARG_UNUSED(thread);
	return 0;
}
