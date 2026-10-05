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
	 * Split the stack object. Zephyr puts the ARCH_THREAD_STACK_RESERVED
	 * bytes at the bottom of every stack object, below the buffer the
	 * thread asked for, where other architectures keep a guard. The
	 * Asyncify buffer lives there, at the very bottom; the C shadow stack
	 * grows down from stack_ptr, at the top, towards it. Between them, in a
	 * debugging build, is the headroom (CONFIG_WASM_STACK_HEADROOM).
	 *
	 * So the lowest word of the buffer the thread asked for,
	 * stack_info.start, is the bottom of its C stack, which is where
	 * CONFIG_STACK_SENTINEL puts its sentinel. A C stack that overflows runs
	 * into the headroom and then this thread's own Asyncify buffer, never
	 * into another object. The buffer used to be carved from the top, below
	 * stack_ptr, and the C stack then grew through the sentinel and the
	 * reserved bytes beneath it.
	 *
	 * Asyncify wants a two-word header at the front of its buffer: the
	 * current cursor and the end. It never bounds-checks that end, so the
	 * buffer has to be big enough for the deepest stack this thread can
	 * reach (DESIGN.md D8). The host checks the cursor after every unwind.
	 */
	uintptr_t buf = ROUND_UP((uintptr_t)stack, 16);
	uintptr_t end = buf + CONFIG_WASM_ASYNCIFY_BUFFER_SIZE;
	uint32_t *hdr = (uint32_t *)buf;

	hdr[0] = (uint32_t)(buf + 8);   /* cursor starts past the header */
	hdr[1] = (uint32_t)end;

	thread->callee_saved.sp = (uint32_t)ROUND_DOWN((uintptr_t)stack_ptr, 16);
	thread->callee_saved.asyncify_buf = (uint32_t)buf;
	thread->callee_saved.asyncify_end = (uint32_t)end;
	thread->callee_saved.fresh = 1U;
	thread->arch.irq_lock_key = 0U;   /* starts with interrupts unmasked */
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
