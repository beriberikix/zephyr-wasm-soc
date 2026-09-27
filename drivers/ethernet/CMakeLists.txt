# SPDX-License-Identifier: Apache-2.0
if(CONFIG_ETH_WASM_HOST)
  zephyr_library_amend()
  zephyr_library_sources(eth_wasm_host.c)
endif()
