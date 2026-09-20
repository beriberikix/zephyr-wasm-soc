# SPDX-License-Identifier: Apache-2.0

set(CMAKE_C_COMPILER   ${WASM_LLVM_PATH}/bin/clang)
set(CMAKE_CXX_COMPILER ${WASM_LLVM_PATH}/bin/clang++)
set(CMAKE_ASM_COMPILER ${WASM_LLVM_PATH}/bin/clang)

set(triple wasm32-unknown-unknown)
set(CMAKE_C_COMPILER_TARGET   ${triple})
set(CMAKE_ASM_COMPILER_TARGET ${triple})
set(CMAKE_CXX_COMPILER_TARGET ${triple})

list(APPEND TOOLCHAIN_C_FLAGS   --target=${triple})
list(APPEND TOOLCHAIN_LD_FLAGS  --target=${triple})

# CMake's compiler checks link a full executable, and wasm-ld refuses to link
# one without an entry symbol. This module has no _start: the host calls
# z_wasm_boot directly. Building the probes as static libraries keeps the
# checks meaningful without dragging a link into them, which is the usual
# arrangement for a freestanding target.
set(CMAKE_TRY_COMPILE_TARGET_TYPE STATIC_LIBRARY)
