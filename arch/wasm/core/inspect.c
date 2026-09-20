/*
 * What the host may ask about the kernel's threads.
 *
 * The host knows no Zephyr struct offsets and should not learn any: a host
 * that knew them would go quietly wrong whenever a struct moved, and the
 * offsets are generated per build precisely because they are not stable. So
 * the guest answers questions rather than being read, and the answer has a
 * shape both sides agree on: struct wasm_thread_info in wasm_host.h.
 *
 * When this is safe to call is the interesting part. The host calls it
 * between steps, which is the moment the guest is fully unwound: Asyncify is
 * NORMAL, no thread is mid-switch, and _kernel.cpus[0].current already names
 * the thread that will run next. Nothing here takes a lock -- there is one
 * CPU and nothing else is running -- and nothing here may suspend, because a
 * suspension outside the driver loop would corrupt the Asyncify state the
 * host is holding.
 *
 * It also must not be instrumented: a safepoint inside this walk would
 * dispatch interrupts and reschedule from a call the kernel did not make.
 * scripts/instrument_safepoints.py skips it by export name, and refuses to
 * run if it cannot find it.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

#include <zephyr/kernel.h>
#include <zephyr/kernel_structs.h>
#include <zephyr/arch/wasm/wasm_host.h>

/* A stack of its own, so the walk does not spend the headroom of whichever
 * thread happens to be suspended. The host points __stack_pointer here for
 * the call and puts it back afterwards.
 */
static uint8_t inspect_stack[CONFIG_WASM_INSPECT_STACK_SIZE]
	__attribute__((aligned(16)));

__attribute__((export_name("z_wasm_inspect_stack_top")))
uint32_t z_wasm_inspect_stack_top(void)
{
	/* Shadow stacks grow down. */
	return (uint32_t)(uintptr_t)(inspect_stack + sizeof(inspect_stack));
}

__attribute__((export_name("z_wasm_inspect_threads")))
uint32_t z_wasm_inspect_threads(struct wasm_thread_info *out, uint32_t max)
{
	struct k_thread *current = _kernel.cpus[0].current;
	uint32_t n = 0;

	for (struct k_thread *t = _kernel.threads; t != NULL && n < max; t = t->next_thread) {
		out[n].thread = (uint32_t)(uintptr_t)t;
		out[n].state = t->base.thread_state;
		out[n].is_current = (t == current) ? 1U : 0U;
#ifdef CONFIG_THREAD_NAME
		out[n].name = (uint32_t)(uintptr_t)t->name;
#else
		out[n].name = 0U;
#endif
		out[n].prio = t->base.prio;
#ifdef CONFIG_THREAD_STACK_INFO
		out[n].stack_base = (uint32_t)t->stack_info.start;
		out[n].stack_size = (uint32_t)t->stack_info.size;
#else
		out[n].stack_base = 0U;
		out[n].stack_size = 0U;
#endif
		out[n].sp = (uint32_t)(uintptr_t)t->callee_saved.sp;
		out[n].asyncify_buf = (uint32_t)(uintptr_t)t->callee_saved.asyncify_buf;
		n++;
	}

	return n;
}
