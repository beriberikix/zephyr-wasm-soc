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
 * run if it cannot find it. That covers this function's own loops, which is
 * why the helpers below are always inlined, but not the functions it calls.
 * The one kernel function it calls with a loop, z_timeout_remaining(), is
 * exported by the link for this reason alone and skipped the same way.
 * Even its safepoints could not dispatch, since it holds a lock, but each
 * one counts towards the next progress report, and a report moves virtual
 * time: looking would change what is looked at.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

#include <zephyr/kernel.h>
#include <zephyr/kernel_structs.h>
#include <zephyr/arch/wasm/wasm_host.h>
#include <timeout_q.h>

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

static ALWAYS_INLINE bool is_thread(const struct k_thread *candidate)
{
	for (struct k_thread *t = _kernel.threads; t != NULL; t = t->next_thread) {
		if (t == candidate) {
			return true;
		}
	}
	return false;
}

/*
 * Who holds what a thread is waiting for, when that is a mutex.
 *
 * A wait queue does not say what kind of object it belongs to, and without
 * CONFIG_USERSPACE nothing else records it either. So this infers: the queue
 * is read as a k_mutex's wait_q, and the result is believed only if the
 * owner it finds is a thread in the kernel's list, is not the waiter, and
 * holds the lock at least once. A semaphore with a waiter has a count of
 * zero where the owner would be, and most other objects hold something that
 * is not a thread there. Something that happens to hold a thread pointer in
 * that place would be misread, and the page says "held by" only for this.
 */
static ALWAYS_INLINE uint32_t mutex_owner(const struct k_thread *waiter)
{
	_wait_q_t *q = waiter->base.pended_on;

	if (q == NULL || (waiter->base.thread_state & _THREAD_PENDING) == 0U) {
		return 0U;
	}

	const struct k_mutex *m = CONTAINER_OF(q, struct k_mutex, wait_q);

	if (m->owner == NULL || m->owner == waiter || m->lock_count == 0U ||
	    !is_thread(m->owner)) {
		return 0U;
	}
	return (uint32_t)(uintptr_t)m->owner;
}

static ALWAYS_INLINE int32_t timeout_ms(const struct k_thread *t)
{
#ifdef CONFIG_SYS_CLOCK_EXISTS
	if (z_is_inactive_timeout(&t->base.timeout)) {
		return -1;
	}

	k_ticks_t ticks = z_timeout_remaining(&t->base.timeout);

	return (int32_t)k_ticks_to_ms_ceil32(ticks > 0 ? (uint64_t)ticks : 0U);
#else
	ARG_UNUSED(t);
	return -1;
#endif
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
		out[n].pended_on = (uint32_t)(uintptr_t)t->base.pended_on;
		out[n].held_by = mutex_owner(t);
		out[n].timeout_ms = timeout_ms(t);
		n++;
	}

	return n;
}
