# SPDX-License-Identifier: Apache-2.0
zephyr_library_amend()
zephyr_library_sources_ifdef(CONFIG_INPUT_WASM_HOST input_wasm_host.c)
