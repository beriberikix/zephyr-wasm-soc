# SPDX-License-Identifier: Apache-2.0
# No toolchain libc, no libgcc, no compiler-rt for wasm32 in this install.
# The minimal libc supplies what the kernel needs.
set_linker_property(PROPERTY c_library "")
set_linker_property(PROPERTY rt_library "")
set_linker_property(PROPERTY c++_library "")
set_linker_property(PROPERTY math_library "")
set_linker_property(PROPERTY link_order_library "")
