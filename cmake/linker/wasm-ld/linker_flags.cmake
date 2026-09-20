# SPDX-License-Identifier: Apache-2.0
# wasm-ld shares almost no flags with an ELF linker; the ones Zephyr sets by
# default (--gc-sections, -T, --print-memory-usage, sysroot handling) either do
# not exist or mean something else. Start from nothing.
set_property(TARGET linker PROPERTY devnull)
set_property(TARGET linker PROPERTY gcsections)
set_property(TARGET linker PROPERTY whole_archive)
set_property(TARGET linker PROPERTY no_whole_archive)
set_property(TARGET linker PROPERTY partial_linking)
set_property(TARGET linker PROPERTY base)
set_property(TARGET linker PROPERTY cpp_base)
set_property(TARGET linker PROPERTY baremetal)
set_property(TARGET linker PROPERTY orphan_warning)
set_property(TARGET linker PROPERTY orphan_error)
set_property(TARGET linker PROPERTY ld_script)
