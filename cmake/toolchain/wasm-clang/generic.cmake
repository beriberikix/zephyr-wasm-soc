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

# No libc comes with this toolchain for wasm32. Picolibc is built from
# Zephyr's module instead (DESIGN.md D11). A full C++ standard library needs
# a picolibc and libc++ built together, which scripts/build_sysroot.sh puts
# in a sysroot (D13); if it has been built, the toolchain has both, and the
# board keeps every build that does not need them on the module.
set(WASM_SYSROOT "${ZEPHYR_BASE}/../wasm-sysroot" CACHE PATH "wasm32 sysroot from scripts/build_sysroot.sh")
get_filename_component(WASM_SYSROOT "${WASM_SYSROOT}" ABSOLUTE)
if(EXISTS "${WASM_SYSROOT}/lib/libc.a" AND EXISTS "${WASM_SYSROOT}/lib/libc++.a")
  set(wasm_sysroot ON)
else()
  set(wasm_sysroot OFF)
endif()
set(TOOLCHAIN_HAS_NEWLIB   OFF            CACHE BOOL "True if toolchain supports newlib")
set(TOOLCHAIN_HAS_PICOLIBC ${wasm_sysroot} CACHE BOOL "True if toolchain supports picolibc" FORCE)
set(TOOLCHAIN_HAS_LIBCXX   ${wasm_sysroot} CACHE BOOL "True if toolchain supports libc++" FORCE)

message(STATUS "Found toolchain: wasm-clang (${WASM_LLVM_PATH}, lld at ${WASM_LLD_PATH})")
