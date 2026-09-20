# SPDX-License-Identifier: Apache-2.0
zephyr_library_amend()
zephyr_library_sources_ifdef(CONFIG_WASM_HOST_CONSOLE wasm_host_console.c)
