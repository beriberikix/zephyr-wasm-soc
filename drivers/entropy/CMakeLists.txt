# SPDX-License-Identifier: Apache-2.0
zephyr_library_amend()
zephyr_library_sources_ifdef(CONFIG_ENTROPY_WASM_HOST entropy_wasm_host.c)
