# SPDX-License-Identifier: Apache-2.0

# The build insists on a linker script existing even though wasm-ld has no
# concept of one. Point at a placeholder; the module's linker cmake never
# passes it to the linker. See DESIGN.md.
set(SOC_LINKER_SCRIPT ${CMAKE_CURRENT_LIST_DIR}/linker.ld CACHE INTERNAL "")

# Supplies the linker-section symbols wasm-ld cannot produce.
include(${CMAKE_CURRENT_LIST_DIR}/../../cmake/sections_wasm.cmake)

# Runs after the link: turns the linked module into the Asyncify-transformed
# zephyr.wasm the host actually loads.
include(${CMAKE_CURRENT_LIST_DIR}/../../cmake/postlink_wasm.cmake)

# `west build -t run`.
include(${CMAKE_CURRENT_LIST_DIR}/../../cmake/run_wasm.cmake)
