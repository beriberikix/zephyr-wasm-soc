/*
 * UART over the host's byte imports.
 *
 * Polled, because the host cannot interrupt the guest: an interrupt-driven
 * UART would need the host to raise something while the guest is running, and
 * the only mechanism for that is the pending word, which is only read at
 * safepoints. Polling is enough for a console and a shell.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

#define DT_DRV_COMPAT wasm_host_uart

#include <zephyr/kernel.h>
#include <zephyr/device.h>
#include <zephyr/drivers/uart.h>
#include <zephyr/arch/wasm/wasm_host.h>

static int uart_wasm_host_poll_in(const struct device *dev, unsigned char *c)
{
	ARG_UNUSED(dev);

	int32_t ch = wasm_host_uart_poll_in();

	if (ch < 0) {
		return -1;
	}
	*c = (unsigned char)ch;
	return 0;
}

static void uart_wasm_host_poll_out(const struct device *dev, unsigned char c)
{
	ARG_UNUSED(dev);
	wasm_host_uart_poll_out((int32_t)c);
}

static int uart_wasm_host_err_check(const struct device *dev)
{
	ARG_UNUSED(dev);
	return 0;
}

static DEVICE_API(uart, uart_wasm_host_api) = {
	.poll_in = uart_wasm_host_poll_in,
	.poll_out = uart_wasm_host_poll_out,
	.err_check = uart_wasm_host_err_check,
};

static int uart_wasm_host_init(const struct device *dev)
{
	ARG_UNUSED(dev);
	return 0;
}

#define UART_WASM_HOST_DEFINE(n)                                           \
	DEVICE_DT_INST_DEFINE(n, uart_wasm_host_init, NULL, NULL, NULL,    \
			      PRE_KERNEL_1,                                \
			      CONFIG_SERIAL_INIT_PRIORITY,                 \
			      &uart_wasm_host_api);

DT_INST_FOREACH_STATUS_OKAY(UART_WASM_HOST_DEFINE)
