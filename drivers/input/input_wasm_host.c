/*
 * Input from the host: a touch on the page's display, a key pressed while it
 * has focus.
 *
 * The host queues events and raises WASM_IRQ_INPUT; the ISR drains the queue
 * and hands each event to input_report(), which is how a touch controller's
 * driver delivers them on hardware. The events are the ones native_sim's
 * input_sdl_touch produces -- INPUT_ABS_X and INPUT_ABS_Y in display pixels,
 * then INPUT_BTN_TOUCH with sync -- so anything written against that, LVGL's
 * pointer input included, works here unchanged.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

#define DT_DRV_COMPAT wasm_host_input

#include <zephyr/device.h>
#include <zephyr/irq.h>
#include <zephyr/input/input.h>
#include <zephyr/arch/wasm/wasm_host.h>

static void wasm_input_isr(const void *arg)
{
	const struct device *dev = arg;
	int32_t ev[4];

	/* One sample per interrupt, up to and including its sync event, as a
	 * touch controller interrupts once per report. The host raises the line
	 * again while it has more, so the input thread drains the queue between
	 * samples. Draining everything here overflowed that queue: a drag
	 * delivered between two steps of a paced run is dozens of events, and
	 * K_NO_WAIT, which an interrupt must use, drops what does not fit.
	 */
	while (wasm_host_input_poll(ev)) {
		(void)input_report(dev, (uint8_t)ev[0], (uint16_t)ev[1], ev[2], ev[3] != 0,
				   K_NO_WAIT);
		if (ev[3] != 0) {
			break;
		}
	}
}

#define WASM_INPUT_DEFINE(n)                                                                       \
	static int wasm_input_init_##n(const struct device *dev)                                   \
	{                                                                                          \
		IRQ_CONNECT(DT_INST_IRQN(n), 0, wasm_input_isr, DEVICE_DT_INST_GET(n), 0);        \
		irq_enable(DT_INST_IRQN(n));                                                       \
		return 0;                                                                          \
	}                                                                                          \
	DEVICE_DT_INST_DEFINE(n, wasm_input_init_##n, NULL, NULL, NULL, POST_KERNEL,               \
			      CONFIG_INPUT_INIT_PRIORITY, NULL);

DT_INST_FOREACH_STATUS_OKAY(WASM_INPUT_DEFINE)
