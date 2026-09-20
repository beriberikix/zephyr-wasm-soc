# SPDX-License-Identifier: Apache-2.0
zephyr_library_amend()
zephyr_library_sources_ifdef(CONFIG_WASM_HOST_TIMER wasm_host_timer.c)
