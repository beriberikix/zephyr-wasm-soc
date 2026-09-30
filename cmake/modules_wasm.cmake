# Adjustments to third-party modules' own build settings, for this toolchain.
#
# Each is for a module that builds its own targets with its own flags, so
# Zephyr's options do not reach them, and each is as narrow as it can be: one
# target, one warning. They run once the whole tree has been configured,
# because the modules' targets do not exist before that.
#
# SPDX-License-Identifier: Apache-2.0

function(wasm_adjust_modules)
  # mbedTLS builds itself with -Werror. clang 21 added
  # -Wuninitialized-const-pointer, which fires in x509_crt.c on a
  # mbedtls_x509_time that is passed by pointer but only read when
  # MBEDTLS_HAVE_TIME_DATE is on. With it off, as here, nothing reads it, so
  # the warning is a false positive, and it is the same on every target
  # built with clang 21. upstream/README.md has the one-line fix for
  # mbedTLS.
  if(TARGET mbedx509)
    target_compile_options(mbedx509 PRIVATE -Wno-uninitialized-const-pointer)
  endif()

  # SyS-T, the MIPI trace format, can tag a record with the address of the
  # call that made it, and mipi-sys-t implements that with
  # __builtin_return_address(0). Clang has no such thing for wasm, and could
  # not: code is not in linear memory, so there is no instruction address to
  # give. The records carry 0 for it instead, which SyS-T decoders read as
  # "no address". The library is a zephyr_library, named from its path.
  if(DEFINED ZEPHYR_MIPI_SYS_T_MODULE_DIR)
    file(RELATIVE_PATH syst ${ZEPHYR_BASE} ${ZEPHYR_MIPI_SYS_T_MODULE_DIR})
    string(REPLACE "/" "__" syst ${syst})
    if(TARGET ${syst})
      # A compile option, not a definition: CMake drops function-like ones.
      target_compile_options(${syst} PRIVATE "-D__builtin_return_address(level)=((void*)0)")
    endif()
  endif()
endfunction()

cmake_language(DEFER DIRECTORY "${ZEPHYR_BASE}" CALL wasm_adjust_modules)
