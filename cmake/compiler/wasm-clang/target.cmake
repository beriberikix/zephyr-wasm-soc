# SPDX-License-Identifier: Apache-2.0
include(${ZEPHYR_BASE}/cmake/compiler/clang/target.cmake)

# Wasm is little-endian, and picolibc's own sources need telling so. See the
# definition in arch/wasm/CMakeLists.txt for why, and why it is in both places.
list(APPEND TOOLCHAIN_C_FLAGS -D__FLOAT_WORD_ORDER__=__ORDER_LITTLE_ENDIAN__)
