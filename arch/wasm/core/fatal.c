/*
 * Fatal errors, and the CPU exception a wasm trap stands in for.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

#include <zephyr/kernel.h>
#include <zephyr/fatal.h>
#include <zephyr/arch/wasm/wasm_host.h>
#include <kswap.h>

/*
 * z_fatal_error() returns when the thread it would abort cannot be switched
 * away from here: one already dead, like an essential thread that aborted
 * itself and panicked on the way out, or the current thread from an ISR. The
 * caller then carries on, and the kernel's own path switches away, as it does
 * after the exception returns on arm64. Treating the return as unreachable
 * trapped instead (tests/kernel/threads/thread_apis).
 */
void z_wasm_fatal_error(unsigned int reason, const struct arch_esf *esf)
{
	z_fatal_error(reason, esf);
}

/*
 * A trap, raised as the CPU exception it would be on hardware (DESIGN.md D14).
 *
 * A wasm trap -- a call through a bad pointer or with the wrong signature, an
 * integer division by zero, `unreachable` -- unwinds every wasm frame of the
 * running thread to the host. Linear memory, and with it the kernel's state,
 * is untouched. So the host calls this, on the trapped thread's stack, and
 * the kernel does what it does after a CPU exception anywhere else: reports
 * it, asks k_sys_fatal_error_handler(), and aborts the thread, which switches
 * away for good.
 *
 * Whatever was running is gone, an interrupt handler included, so the
 * nesting count goes back to thread level first and the interrupted thread is
 * the one aborted. If z_fatal_error() returns, the thread was already dead,
 * and nothing remains but to switch away from it.
 */
__attribute__((export_name("z_wasm_trap")))
void z_wasm_trap(void)
{
	_kernel.cpus[0].nested = 0U;
	z_fatal_error(K_ERR_CPU_EXCEPTION, NULL);
	z_swap_unlocked();
	CODE_UNREACHABLE;
}

FUNC_NORETURN void arch_system_halt(unsigned int reason)
{
	wasm_host_fatal((int32_t)reason, 0);
	CODE_UNREACHABLE;
}
