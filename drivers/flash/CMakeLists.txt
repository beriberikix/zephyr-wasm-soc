# SPDX-License-Identifier: Apache-2.0
zephyr_library_amend()
zephyr_library_sources_ifdef(CONFIG_FLASH_WASM_HOST flash_wasm_host.c)
