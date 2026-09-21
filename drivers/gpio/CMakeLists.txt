# SPDX-License-Identifier: Apache-2.0
zephyr_library_amend()
zephyr_library_sources_ifdef(CONFIG_WASM_GPIO_BRIDGE gpio_wasm_bridge.c)
