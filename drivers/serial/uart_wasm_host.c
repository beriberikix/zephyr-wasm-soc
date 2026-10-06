/*
 * UART over the host's byte imports.
 *
 * Polled, and with CONFIG_UART_INTERRUPT_DRIVEN interrupt-driven as well. The
 * host raises the UART line when bytes arrive for the board, and the guest
 * takes it at the next safepoint like any other interrupt. Nothing tells the
 * guest whether a byte is waiting short of reading it, so the driver keeps
 * one byte of look-ahead. The transmitter is always empty, because the host
 * takes each byte as it is written; a transmit interrupt that is enabled
 * therefore fires at once and keeps firing, as an empty FIFO's does on
 * hardware, and the driver raises the line itself for as long as it is.
 * See DESIGN.md D10.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

#define DT_DRV_COMPAT wasm_host_uart

#include <zephyr/kernel.h>
#include <zephyr/device.h>
#include <zephyr/drivers/uart.h>
#include <zephyr/irq.h>
#include <zephyr/arch/wasm/wasm_host.h>

struct uart_wasm_host_config {
	/* Which of the host's UARTs this is: 0 the console, 1 an HCI line. */
	int32_t port;
};

struct uart_wasm_host_data {
	/* A byte read from the host and not yet handed to the application,
	 * or -1. */
	int32_t ahead;
#ifdef CONFIG_UART_INTERRUPT_DRIVEN
	uart_irq_callback_user_data_t callback;
	void *cb_data;
	bool rx_enabled;
	bool tx_enabled;
	unsigned int irq;
#endif
};

static inline int32_t port_of(const struct device *dev)
{
	return ((const struct uart_wasm_host_config *)dev->config)->port;
}

static int32_t take_byte(const struct device *dev)
{
	struct uart_wasm_host_data *data = dev->data;
	int32_t ch = data->ahead;

	if (ch >= 0) {
		data->ahead = -1;
		return ch;
	}
	return wasm_host_uart_poll_in(port_of(dev));
}

static int uart_wasm_host_poll_in(const struct device *dev, unsigned char *c)
{
	int32_t ch = take_byte(dev);

	if (ch < 0) {
		return -1;
	}
	*c = (unsigned char)ch;
	return 0;
}

static void uart_wasm_host_poll_out(const struct device *dev, unsigned char c)
{
	wasm_host_uart_poll_out(port_of(dev), (int32_t)c);
}

static int uart_wasm_host_err_check(const struct device *dev)
{
	ARG_UNUSED(dev);
	return 0;
}

#ifdef CONFIG_UART_INTERRUPT_DRIVEN

static bool rx_waiting(const struct device *dev)
{
	struct uart_wasm_host_data *data = dev->data;

	if (data->ahead < 0) {
		data->ahead = wasm_host_uart_poll_in(port_of(dev));
	}
	return data->ahead >= 0;
}

static int uart_wasm_host_fifo_fill(const struct device *dev, const uint8_t *buf, int len)
{
	for (int i = 0; i < len; i++) {
		wasm_host_uart_poll_out(port_of(dev), (int32_t)buf[i]);
	}
	return len;
}

static int uart_wasm_host_fifo_read(const struct device *dev, uint8_t *buf, const int size)
{
	int n = 0;

	while (n < size) {
		int32_t ch = take_byte(dev);

		if (ch < 0) {
			break;
		}
		buf[n++] = (uint8_t)ch;
	}
	return n;
}

static void uart_wasm_host_irq_tx_enable(const struct device *dev)
{
	struct uart_wasm_host_data *data = dev->data;

	data->tx_enabled = true;
	z_wasm_irq_raise(data->irq);
}

static void uart_wasm_host_irq_tx_disable(const struct device *dev)
{
	((struct uart_wasm_host_data *)dev->data)->tx_enabled = false;
}

static int uart_wasm_host_irq_tx_ready(const struct device *dev)
{
	/* The host takes every byte at once, so there is always room. */
	return ((struct uart_wasm_host_data *)dev->data)->tx_enabled ? 1 : 0;
}

static int uart_wasm_host_irq_tx_complete(const struct device *dev)
{
	ARG_UNUSED(dev);
	return 1;
}

static void uart_wasm_host_irq_rx_enable(const struct device *dev)
{
	struct uart_wasm_host_data *data = dev->data;

	data->rx_enabled = true;
	/* Bytes may have arrived while receive was off. */
	if (rx_waiting(dev)) {
		z_wasm_irq_raise(data->irq);
	}
}

static void uart_wasm_host_irq_rx_disable(const struct device *dev)
{
	((struct uart_wasm_host_data *)dev->data)->rx_enabled = false;
}

static int uart_wasm_host_irq_rx_ready(const struct device *dev)
{
	struct uart_wasm_host_data *data = dev->data;

	return (data->rx_enabled && rx_waiting(dev)) ? 1 : 0;
}

static void uart_wasm_host_irq_err_enable(const struct device *dev)
{
	ARG_UNUSED(dev);
}

static void uart_wasm_host_irq_err_disable(const struct device *dev)
{
	ARG_UNUSED(dev);
}

static int uart_wasm_host_irq_is_pending(const struct device *dev)
{
	return uart_wasm_host_irq_tx_ready(dev) || uart_wasm_host_irq_rx_ready(dev);
}

static void uart_wasm_host_irq_update(const struct device *dev)
{
	ARG_UNUSED(dev);
}

static void uart_wasm_host_irq_callback_set(const struct device *dev,
					    uart_irq_callback_user_data_t cb, void *cb_data)
{
	struct uart_wasm_host_data *data = dev->data;

	data->callback = cb;
	data->cb_data = cb_data;
}

static void uart_wasm_host_isr(const struct device *dev)
{
	struct uart_wasm_host_data *data = dev->data;

	if (data->callback != NULL &&
	    (data->tx_enabled || (data->rx_enabled && rx_waiting(dev)))) {
		data->callback(dev, data->cb_data);
	}

	/* Level-triggered, as the conditions are on hardware: an enabled
	 * transmitter is still empty, and bytes the callback left unread are
	 * still waiting.
	 */
	if (data->tx_enabled || (data->rx_enabled && rx_waiting(dev))) {
		z_wasm_irq_raise(data->irq);
	}
}

#endif /* CONFIG_UART_INTERRUPT_DRIVEN */

static DEVICE_API(uart, uart_wasm_host_api) = {
	.poll_in = uart_wasm_host_poll_in,
	.poll_out = uart_wasm_host_poll_out,
	.err_check = uart_wasm_host_err_check,
#ifdef CONFIG_UART_INTERRUPT_DRIVEN
	.fifo_fill = uart_wasm_host_fifo_fill,
	.fifo_read = uart_wasm_host_fifo_read,
	.irq_tx_enable = uart_wasm_host_irq_tx_enable,
	.irq_tx_disable = uart_wasm_host_irq_tx_disable,
	.irq_tx_ready = uart_wasm_host_irq_tx_ready,
	.irq_tx_complete = uart_wasm_host_irq_tx_complete,
	.irq_rx_enable = uart_wasm_host_irq_rx_enable,
	.irq_rx_disable = uart_wasm_host_irq_rx_disable,
	.irq_rx_ready = uart_wasm_host_irq_rx_ready,
	.irq_err_enable = uart_wasm_host_irq_err_enable,
	.irq_err_disable = uart_wasm_host_irq_err_disable,
	.irq_is_pending = uart_wasm_host_irq_is_pending,
	.irq_update = uart_wasm_host_irq_update,
	.irq_callback_set = uart_wasm_host_irq_callback_set,
#endif
};

#ifdef CONFIG_UART_INTERRUPT_DRIVEN
#define UART_WASM_HOST_IRQ_INIT(n)                                                                 \
	do {                                                                                       \
		data->irq = DT_INST_IRQN(n);                                                       \
		IRQ_CONNECT(DT_INST_IRQN(n), 0, uart_wasm_host_isr, DEVICE_DT_INST_GET(n), 0);     \
		irq_enable(DT_INST_IRQN(n));                                                       \
	} while (false)
#else
#define UART_WASM_HOST_IRQ_INIT(n) ARG_UNUSED(data)
#endif

#define UART_WASM_HOST_DEFINE(n)                                                                   \
	static const struct uart_wasm_host_config uart_wasm_host_config_##n = {                   \
		.port = DT_INST_PROP(n, port),                                                     \
	};                                                                                         \
	static struct uart_wasm_host_data uart_wasm_host_data_##n = {.ahead = -1};                \
	static int uart_wasm_host_init_##n(const struct device *dev)                              \
	{                                                                                          \
		struct uart_wasm_host_data *data = dev->data;                                      \
		UART_WASM_HOST_IRQ_INIT(n);                                                        \
		return 0;                                                                          \
	}                                                                                          \
	DEVICE_DT_INST_DEFINE(n, uart_wasm_host_init_##n, NULL, &uart_wasm_host_data_##n,        \
			      &uart_wasm_host_config_##n,                                          \
			      PRE_KERNEL_1, CONFIG_SERIAL_INIT_PRIORITY, &uart_wasm_host_api);

DT_INST_FOREACH_STATUS_OKAY(UART_WASM_HOST_DEFINE)
