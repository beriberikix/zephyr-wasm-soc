# SPDX-License-Identifier: Apache-2.0
#
# Start from clang's ordinary Zephyr flags, then drop the ones that assume an
# ELF target with a linker script.
include(${ZEPHYR_BASE}/cmake/compiler/clang/compiler_flags.cmake)

# wasm-ld has no --gc-sections in the ELF sense and no linker script to place
# the resulting pieces, and splitting every function into its own section
# makes the output harder to read for no gain.
set_compiler_property(PROPERTY no_common -fno-common)
set_compiler_property(PROPERTY optimization_debug -O0)

# Freestanding: no host headers, no host libc, no builtins we cannot provide.
check_set_compiler_property(APPEND PROPERTY general
  -ffreestanding
  -fno-builtin
  -nostdinc
)
