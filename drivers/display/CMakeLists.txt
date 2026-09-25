# SPDX-License-Identifier: Apache-2.0
zephyr_library_amend()
zephyr_library_sources_ifdef(CONFIG_DISPLAY_WASM_HOST display_wasm_host.c)
