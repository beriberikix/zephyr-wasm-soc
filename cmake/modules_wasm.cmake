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
endfunction()

cmake_language(DEFER DIRECTORY "${ZEPHYR_BASE}" CALL wasm_adjust_modules)
