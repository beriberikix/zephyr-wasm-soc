# SPDX-License-Identifier: Apache-2.0
# No toolchain libc, no libgcc, no compiler-rt for wasm32 in this install.
# The minimal libc is compiled into the kernel's own libraries and needs no
# entry here. Picolibc, built from its module, is a separate libc.a: the
# module sets c_library to its path, and toolchain_ld_link_elf() in target.cmake
# puts everything named in link_order_library at the end of the link.
set_linker_property(PROPERTY c_library "")
set_linker_property(PROPERTY rt_library "")
set_linker_property(PROPERTY c++_library "")
set_linker_property(PROPERTY math_library "")
set_linker_property(PROPERTY link_order_library "")
if(NOT CONFIG_MINIMAL_LIBC)
  set_property(TARGET linker APPEND PROPERTY link_order_library "c")
endif()
