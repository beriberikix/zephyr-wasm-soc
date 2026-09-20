# SPDX-License-Identifier: Apache-2.0

# The build insists on a linker script existing even though wasm-ld has no
# concept of one. Point at a placeholder; the module's linker cmake never
# passes it to the linker. See DESIGN.md.
set(SOC_LINKER_SCRIPT ${CMAKE_CURRENT_LIST_DIR}/linker.ld CACHE INTERNAL "")
