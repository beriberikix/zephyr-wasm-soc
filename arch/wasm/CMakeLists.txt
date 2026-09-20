# SPDX-License-Identifier: Apache-2.0

# Zephyr generates offsets.h by reading absolute symbols out of an ELF object.
# Wasm has none, so swap in a generator that reads the constants back from the
# compiler's assembly output instead. This has to happen here: the root
# CMakeLists.txt reaches add_subdirectory(arch) before it declares the offsets
# library, so redefining the function now is what takes effect there.
include(${CMAKE_CURRENT_LIST_DIR}/../../cmake/offsets_wasm.cmake)

add_subdirectory(core)
zephyr_include_directories(include)
