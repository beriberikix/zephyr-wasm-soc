# SPDX-License-Identifier: Apache-2.0
#
# Naming a platform here keeps Zephyr from defining its own `run` target that
# only prints "not supported". Zephyr then looks for cmake/emu/wasm.cmake
# inside its own tree and finds nothing, which leaves the name free for the
# module to define; see cmake/run_wasm.cmake.
set(SUPPORTED_EMU_PLATFORMS wasm)
