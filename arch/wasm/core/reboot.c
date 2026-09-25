/*
 * Reboot. The host starts a new instance of the module and keeps the
 * simulated flash, which is what surviving a reset means on hardware.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

#include <zephyr/kernel.h>
#include <zephyr/sys/reboot.h>
#include <zephyr/arch/wasm/wasm_host.h>

void sys_arch_reboot(int type)
{
	wasm_host_reboot((int32_t)type);
	CODE_UNREACHABLE;
}
