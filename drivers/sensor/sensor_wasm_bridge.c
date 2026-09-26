/*
 * What the board's emulated sensors measure, set by the host.
 *
 * The sensors are upstream's emulators and the drivers are the real ones, so
 * a sample reads an accelerometer over I2C exactly as it would on hardware.
 * Something has to decide what the emulated chip reports, and on this board
 * that is the host: a page can tilt the board, and a scripted run can say
 * what the reading is at a given moment. This bridge is how it gets there.
 * The host queues readings and raises WASM_IRQ_SENSOR; the ISR hands each one
 * to the emulator through emul_sensor_backend_set_channel(), the call a test
 * would make, and the emulator puts it in the registers the driver reads.
 *
 * Nothing here is a sensor driver, and with no readings queued the emulators
 * report what they always would, so a run nobody touches is unchanged.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

#define DT_DRV_COMPAT wasm_host_sensor_bridge

#include <zephyr/device.h>
#include <zephyr/drivers/emul.h>
#include <zephyr/drivers/emul_sensor.h>
#include <zephyr/irq.h>
#include <zephyr/logging/log.h>
#include <zephyr/arch/wasm/wasm_host.h>

LOG_MODULE_REGISTER(sensor_wasm_bridge, CONFIG_SENSOR_LOG_LEVEL);

struct sensor_bridge_config {
	const struct emul *const *emuls;
	size_t count;
};

/* A reading in millionths of its SI unit, as q31_t and a shift: the smallest
 * shift whose range holds the value, so as little precision is lost as
 * possible. value = q31 * 2^(shift - 31). */
static q31_t micro_to_q31(int32_t micro, int8_t *shift)
{
	int64_t mag = micro < 0 ? -(int64_t)micro : micro;
	int8_t s = 0;

	while (s < 31 && mag >= (INT64_C(1000000) << s)) {
		s++;
	}
	*shift = s;
	return (q31_t)(((int64_t)micro << (31 - s)) / 1000000);
}

static void sensor_bridge_isr(const void *arg)
{
	const struct device *dev = arg;
	const struct sensor_bridge_config *cfg = dev->config;
	int32_t ev[3];

	while (wasm_host_sensor_poll(ev)) {
		if (ev[0] < 0 || (size_t)ev[0] >= cfg->count) {
			LOG_WRN("host named sensor %d of %zu", ev[0], cfg->count);
			continue;
		}

		struct sensor_chan_spec ch = {.chan_type = ev[1], .chan_idx = 0};
		int8_t shift;
		q31_t value = micro_to_q31(ev[2], &shift);
		int rc = emul_sensor_backend_set_channel(cfg->emuls[ev[0]], ch, &value, shift);

		if (rc < 0) {
			LOG_WRN("%s: cannot set channel %d: %d", cfg->emuls[ev[0]]->dev->name,
				ev[1], rc);
		}
	}
}

#define BRIDGE_EMUL(node_id, prop, idx) EMUL_DT_GET(DT_PHANDLE_BY_IDX(node_id, prop, idx)),

#define SENSOR_BRIDGE_DEFINE(n)                                                                    \
	static const struct emul *const sensor_bridge_emuls_##n[] = {                              \
		DT_INST_FOREACH_PROP_ELEM(n, sensors, BRIDGE_EMUL)};                               \
	static const struct sensor_bridge_config sensor_bridge_config_##n = {                     \
		.emuls = sensor_bridge_emuls_##n,                                                  \
		.count = ARRAY_SIZE(sensor_bridge_emuls_##n),                                      \
	};                                                                                         \
	static int sensor_bridge_init_##n(const struct device *dev)                                \
	{                                                                                          \
		IRQ_CONNECT(DT_INST_IRQN(n), 0, sensor_bridge_isr, DEVICE_DT_INST_GET(n), 0);      \
		irq_enable(DT_INST_IRQN(n));                                                       \
		return 0;                                                                          \
	}                                                                                          \
	DEVICE_DT_INST_DEFINE(n, sensor_bridge_init_##n, NULL, NULL, &sensor_bridge_config_##n,    \
			      POST_KERNEL, CONFIG_SENSOR_INIT_PRIORITY, NULL);

DT_INST_FOREACH_STATUS_OKAY(SENSOR_BRIDGE_DEFINE)
