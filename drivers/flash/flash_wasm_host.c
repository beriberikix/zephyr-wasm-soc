/*
 * The simulated flash, made to outlive a run.
 *
 * Upstream's flash simulator keeps the whole device as one static array,
 * which on this board is part of linear memory, and erases it at init. This
 * runs straight after that and hands the host the array's address, so the
 * host can copy a saved image in before anything reads it. Saving is the
 * host's side alone: it can read linear memory whenever the guest is paused,
 * so nothing here waits for storage and no import has to suspend.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

#include <zephyr/init.h>
#include <zephyr/device.h>
#include <zephyr/drivers/flash/flash_simulator.h>
#include <zephyr/arch/wasm/wasm_host.h>

#define FLASH_CTRL DT_CHOSEN(zephyr_flash_controller)

/* One past the flash driver, so the array has been erased and not yet read.
 * The priority is a literal because SYS_INIT pastes it into a section name.
 */
#define FLASH_WASM_HOST_INIT_PRIORITY 51
BUILD_ASSERT(CONFIG_FLASH_INIT_PRIORITY < FLASH_WASM_HOST_INIT_PRIORITY,
	     "the host must attach after the flash simulator has erased its array");

static int flash_wasm_host_init(void)
{
	const struct device *dev = DEVICE_DT_GET(FLASH_CTRL);
	size_t size = 0;
	void *mem;

	if (!device_is_ready(dev)) {
		return 0;
	}
	mem = flash_simulator_get_memory(dev, &size);
	wasm_host_storage_attach(mem, (int32_t)size);
	return 0;
}

SYS_INIT(flash_wasm_host_init, POST_KERNEL, FLASH_WASM_HOST_INIT_PRIORITY);
