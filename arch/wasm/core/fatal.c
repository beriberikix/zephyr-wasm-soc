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

void z_wasm_fatal_error(unsigned int reason, const struct arch_esf *esf)
{
	z_fatal_error(reason, esf);
	CODE_UNREACHABLE;
}

FUNC_NORETURN void arch_system_halt(unsigned int reason)
{
	wasm_host_fatal((int32_t)reason, 0);
	CODE_UNREACHABLE;
}
