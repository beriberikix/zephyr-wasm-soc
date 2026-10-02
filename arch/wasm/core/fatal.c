/*
 * Fatal errors.
 *
 * A wasm trap unwinds to the host with no diagnosis and no way back in, so
 * everything the kernel wants to say has to be said before the trap, through
 * the host's fatal import.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

#include <zephyr/kernel.h>
#include <zephyr/fatal.h>
#include <zephyr/arch/wasm/wasm_host.h>

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

FUNC_NORETURN void arch_system_halt(unsigned int reason)
{
	wasm_host_fatal((int32_t)reason, 0);
	CODE_UNREACHABLE;
}
