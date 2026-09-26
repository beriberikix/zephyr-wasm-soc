# SPDX-License-Identifier: Apache-2.0
zephyr_library_amend()
zephyr_library_sources_ifdef(CONFIG_SENSOR_WASM_BRIDGE sensor_wasm_bridge.c)
