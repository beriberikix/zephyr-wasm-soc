/*
 * Semihosting: I/O on the host, which is what a wasm target has instead of a
 * debugger. Zephyr's arch/common/semihost.c builds each operation's argument
 * block; this hands it across. See DESIGN.md D8n.
 * SPDX-License-Identifier: Apache-2.0
 */

#include <zephyr/arch/common/semihost.h>
#include <zephyr/arch/wasm/wasm_host.h>

long semihost_exec(enum semihost_instr instr, void *args)
{
	return wasm_host_semihost((int32_t)instr, args);
}
