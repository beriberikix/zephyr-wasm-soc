/*
 * Carries Zephyr's emulated GPIO ports across to the host.
 *
 * The pins are not implemented here. drivers/gpio/gpio_emul.c already knows
 * about direction, pull, edge and level triggering and the callback list, and
 * it is board agnostic, so a learner running blinky on this target runs the
 * same GPIO code they would run anywhere else. This file is only the wire
 * between that controller and the page:
 *
 *   out  a callback registered on every pin fires whenever an output
 *        changes, and reports the new port value to the host.
 *   in   the host raises WASM_IRQ_GPIO when it has moved an input; the ISR
 *        reads the new levels, works out which pins changed, and hands them
 *        to gpio_emul, which raises the edges and fires the callbacks.
 *
 * Levels crossing to the host are physical, not logical: bit N is the voltage
 * on pin N. An active-low button therefore reads 1 when it is not pressed,
 * which is also the level its pull-up gives it at boot -- the bridge forwards
 * changes only, so the two have to agree.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

#define DT_DRV_COMPAT wasm_host_gpio_bridge

#include <zephyr/kernel.h>
#include <zephyr/device.h>
#include <zephyr/init.h>
#include <zephyr/irq.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/drivers/gpio/gpio_emul.h>
#include <zephyr/arch/wasm/wasm_host.h>

#define BRIDGE_NODE DT_DRV_INST(0)
#define PORT_COUNT  DT_PROP_LEN(BRIDGE_NODE, ports)

struct bridge_port {
	const struct device *dev;
	struct gpio_callback cb;
	gpio_port_value_t last_out;
	uint32_t last_in;
	/* Which pins this port actually has. gpio_emul rejects a mask with a
	 * bit outside it rather than ignoring the extra bits, so asking about
	 * all 32 gets -EINVAL and nothing else. */
	gpio_port_pins_t pin_mask;
	uint8_t index;
};

static struct bridge_port ports[PORT_COUNT];

/*
 * gpio_emul fires the callback list for an output change as well as for an
 * input edge, so this runs more often than there is news. Re-reading and
 * comparing keeps the host from being told the same thing twice, which
 * matters because every call crosses into JavaScript.
 */
static void out_changed(const struct device *dev, struct gpio_callback *cb, uint32_t pins)
{
	struct bridge_port *port = CONTAINER_OF(cb, struct bridge_port, cb);
	gpio_port_value_t values;

	ARG_UNUSED(dev);
	ARG_UNUSED(pins);

	if (gpio_emul_output_get_masked(port->dev, port->pin_mask, &values) != 0) {
		return;
	}
	if (values != port->last_out) {
		port->last_out = values;
		wasm_host_gpio_out(port->index, (uint32_t)values);
	}
}

/*
 * Runs in interrupt context, at whatever safepoint the guest reached. Pushing
 * the change through gpio_emul rather than straight at the callbacks is what
 * makes the edge configuration, the pull and the active-low handling upstream
 * code rather than something reimplemented here.
 */
static void gpio_isr(const void *arg)
{
	ARG_UNUSED(arg);

	for (int i = 0; i < PORT_COUNT; i++) {
		struct bridge_port *port = &ports[i];
		uint32_t now = wasm_host_gpio_in(port->index) & port->pin_mask;
		uint32_t changed = (now ^ port->last_in) & port->pin_mask;

		if (changed == 0) {
			continue;
		}
		port->last_in = now;
		(void)gpio_emul_input_set_masked(port->dev, changed, now);
	}
}

#define BRIDGE_PORT_ENTRY(node_id, prop, idx)                                                      \
	{                                                                                          \
		.dev = DEVICE_DT_GET(DT_PHANDLE_BY_IDX(node_id, prop, idx)),                       \
		.pin_mask = BIT_MASK(DT_PROP(DT_PHANDLE_BY_IDX(node_id, prop, idx), ngpios)),      \
		.index = idx,                                                                      \
	},

static int bridge_init(void)
{
	static const struct bridge_port initial[] = {
		DT_FOREACH_PROP_ELEM(BRIDGE_NODE, ports, BRIDGE_PORT_ENTRY)
	};

	for (int i = 0; i < PORT_COUNT; i++) {
		struct bridge_port *port = &ports[i];

		port->dev = initial[i].dev;
		port->index = initial[i].index;
		port->pin_mask = initial[i].pin_mask;
		port->pin_mask = initial[i].pin_mask;
		if (!device_is_ready(port->dev)) {
			return -ENODEV;
		}

		/* Recorded, not pushed: the pull levels gpio_emul gives the
		 * pins at boot are the truth, and the host agrees with them by
		 * construction. Pushing here would raise an edge for a button
		 * nobody touched.
		 */
		port->last_in = wasm_host_gpio_in(port->index) & port->pin_mask;
		port->last_out = 0;

		gpio_init_callback(&port->cb, out_changed, port->pin_mask);
		(void)gpio_add_callback(port->dev, &port->cb);
	}

	IRQ_CONNECT(DT_IRQN(BRIDGE_NODE), 0, gpio_isr, NULL, 0);
	irq_enable(DT_IRQN(BRIDGE_NODE));
	return 0;
}

/*
 * After the ports and before whatever uses them.
 *
 * gpio_emul is POST_KERNEL at CONFIG_GPIO_INIT_PRIORITY, which is 40 by
 * default, not PRE_KERNEL as a first guess would have it -- and asking a
 * device that has not initialised whether it is ready gets an honest no, so
 * this failed silently until someone printed it. The consumers on the other
 * side, gpio-leds and gpio-keys, are POST_KERNEL at 90. This sits between.
 */
SYS_INIT(bridge_init, POST_KERNEL, CONFIG_WASM_GPIO_BRIDGE_INIT_PRIORITY);
