/*
 * Entropy from the host.
 *
 * Not a real entropy source. The host's default generator is seeded and
 * produces the same bytes every run, because two runs of a build are required
 * to be byte-identical and a real random source would end that; the host has
 * a flag for anyone who wants the platform's own randomness instead. Which of
 * the two is in use is host policy and not visible from here.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

#define DT_DRV_COMPAT wasm_host_entropy

#include <zephyr/kernel.h>
#include <zephyr/device.h>
#include <zephyr/drivers/entropy.h>
#include <zephyr/arch/wasm/wasm_host.h>

static int entropy_wasm_host_get(const struct device *dev, uint8_t *buf, uint16_t len)
{
	ARG_UNUSED(dev);

	wasm_host_entropy_get(buf, (int32_t)len);
	return 0;
}

/* Safe from an ISR too: the import writes the buffer and returns, and there
 * is no lock anywhere in the path.
 */
static int entropy_wasm_host_get_isr(const struct device *dev, uint8_t *buf, uint16_t len,
				     uint32_t flags)
{
	ARG_UNUSED(flags);

	(void)entropy_wasm_host_get(dev, buf, len);
	return len;
}

static DEVICE_API(entropy, entropy_wasm_host_api) = {
	.get_entropy = entropy_wasm_host_get,
	.get_entropy_isr = entropy_wasm_host_get_isr,
};

DEVICE_DT_INST_DEFINE(0, NULL, NULL, NULL, NULL,
		      PRE_KERNEL_1, CONFIG_ENTROPY_INIT_PRIORITY,
		      &entropy_wasm_host_api);
