# SPDX-License-Identifier: Apache-2.0

# Zephyr generates offsets.h by reading absolute symbols out of an ELF object.
# Wasm has none, so swap in a generator that reads the constants back from the
# compiler's assembly output instead. This has to happen here: the root
# CMakeLists.txt reaches add_subdirectory(arch) before it declares the offsets
# library, so redefining the function now is what takes effect there.
include(${CMAKE_CURRENT_LIST_DIR}/../../cmake/offsets_wasm.cmake)

add_subdirectory(core)
zephyr_include_directories(include)

# Picolibc's <machine/ieeefp.h> learns the float byte order from a list of
# architectures, which has no wasm, and falls back on __FLOAT_WORD_ORDER__,
# which clang does not define for wasm32. Wasm is little-endian by
# specification, so say so. Without it every picolibc source, and everything
# that includes <stdint.h> under picolibc, stops at "Endianess not declared".
# It is set twice because two kinds of compile need it: this reaches
# everything built against zephyr_interface, the offsets generator included,
# and cmake/compiler/wasm-clang/target.cmake reaches picolibc's own sources,
# which the module builds without zephyr_interface's definitions.
zephyr_compile_definitions(__FLOAT_WORD_ORDER__=__ORDER_LITTLE_ENDIAN__)
