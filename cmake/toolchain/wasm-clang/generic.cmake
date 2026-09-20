# SPDX-License-Identifier: Apache-2.0
#
# clang plus wasm-ld targeting wasm32-unknown-unknown.
#
# Homebrew's llvm and lld are separate, keg-only formulas, so both paths are
# configurable and both end up on the tool search path.

set_ifndef(WASM_LLVM_PATH "$ENV{WASM_LLVM_HOME}")
set_ifndef(WASM_LLD_PATH  "$ENV{WASM_LLD_HOME}")
zephyr_get(WASM_LLVM_PATH)
zephyr_get(WASM_LLD_PATH)

if(NOT WASM_LLVM_PATH)
  set(WASM_LLVM_PATH /opt/homebrew/opt/llvm)
endif()
if(NOT WASM_LLD_PATH)
  set(WASM_LLD_PATH /opt/homebrew/opt/lld)
endif()

set(WASM_LLVM_PATH ${WASM_LLVM_PATH} CACHE PATH "clang install directory")
set(WASM_LLD_PATH  ${WASM_LLD_PATH}  CACHE PATH "wasm-ld install directory")
set(TOOLCHAIN_HOME ${WASM_LLVM_PATH}/bin/)

set(COMPILER wasm-clang)
set(LINKER   wasm-ld)
set(BINTOOLS wasm)

# The minimal libc is the only option here: there is no wasm32 picolibc or
# newlib in this toolchain.
set(TOOLCHAIN_HAS_NEWLIB   OFF CACHE BOOL "True if toolchain supports newlib")
set(TOOLCHAIN_HAS_PICOLIBC OFF CACHE BOOL "True if toolchain supports picolibc")
set(TOOLCHAIN_HAS_LIBCXX   OFF CACHE BOOL "True if toolchain supports libc++")

message(STATUS "Found toolchain: wasm-clang (${WASM_LLVM_PATH}, lld at ${WASM_LLD_PATH})")
