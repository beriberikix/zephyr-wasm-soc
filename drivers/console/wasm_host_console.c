/*
 * Console over the host's console_write import.
 * SPDX-License-Identifier: Apache-2.0
 */

#include <zephyr/kernel.h>
#include <zephyr/init.h>
#include <zephyr/sys/printk.h>
#include <zephyr/sys/printk-hooks.h>
#include <zephyr/arch/wasm/wasm_host.h>

/*
 * printk hands over one character at a time. Buffer a line before crossing
 * into the host: a call per character would dominate the trace and make the
 * output harder to read.
 */
static char line_buf[128];
static size_t line_len;

static void flush(void)
{
	if (line_len != 0U) {
		wasm_host_console_write(line_buf, (int32_t)line_len);
		line_len = 0U;
	}
}

static int console_out(int c)
{
	line_buf[line_len++] = (char)c;

	if (c == '\n' || line_len == sizeof(line_buf)) {
		flush();
	}
	return c;
}

static int wasm_host_console_init(void)
{
	__printk_hook_install(console_out);
	return 0;
}

SYS_INIT(wasm_host_console_init, PRE_KERNEL_1, CONFIG_KERNEL_INIT_PRIORITY_DEFAULT);
