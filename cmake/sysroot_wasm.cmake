# The wasm32 sysroot, for a build that needs a full C++ standard library
# (DESIGN.md D13): its picolibc in place of the module's, and libc++.
#
# The build passes -nostdinc, as on every target, so the sysroot's headers
# are named here, libc++'s ahead of the C library's: libc++ wraps the C
# headers and reaches them with #include_next.
#
# SPDX-License-Identifier: Apache-2.0

if(CONFIG_PICOLIBC_USE_TOOLCHAIN)
  if(NOT TOOLCHAIN_HAS_PICOLIBC)
    message(FATAL_ERROR "This build needs the wasm32 sysroot: run "
                        "scripts/build_sysroot.sh (DESIGN.md D13)")
  endif()
  if(CONFIG_EXTERNAL_LIBCPP)
    zephyr_compile_options($<$<COMPILE_LANGUAGE:CXX>:-isystem${WASM_SYSROOT}/include/c++/v1>)
    # libc++'s headers use POSIX and GNU extensions of the C library, as
    # Zephyr says for its own LLVM choice (lib/cpp/CMakeLists.txt). Options
    # rather than definitions: the offsets generator writes the definitions
    # out once for every language, and a language-dependent one differs.
    zephyr_compile_options($<$<COMPILE_LANGUAGE:CXX>:-D_POSIX_C_SOURCE=200809L>)
    zephyr_compile_options($<$<COMPILE_LANGUAGE:CXX>:-D_XOPEN_SOURCE=700>)
    zephyr_compile_options($<$<COMPILE_LANGUAGE:CXX>:-D_GNU_SOURCE>)
    zephyr_link_libraries(${WASM_SYSROOT}/lib/libc++.a ${WASM_SYSROOT}/lib/libc++abi.a)
  endif()
  zephyr_compile_options(-isystem${WASM_SYSROOT}/include)
  zephyr_link_libraries(${WASM_SYSROOT}/lib/libc.a ${WASM_SYSROOT}/lib/libclang_rt.builtins.a)
endif()
