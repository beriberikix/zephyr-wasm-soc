# SPDX-License-Identifier: Apache-2.0
#
# wasm-ld has no linker script, so the two hooks Zephyr expects change shape:
# configure_linker_script() produces nothing, and toolchain_ld_link_elf()
# passes wasm-ld its own flags rather than -T and a script.
#
# The link goes through wasm-ld directly rather than the clang driver: the
# driver drops the wasm name section, and without names a later asyncify
# onlylist would silently match nothing (spike C, DESIGN.md D9).

set(LINKERFLAGPREFIX -Wl)

# Zephyr fails the build if LINKER_SCRIPT names a file that does not exist, and
# then preprocesses it. Neither step has anything to do here, so the macro just
# leaves an empty file where the build expects one.
macro(configure_linker_script linker_script_gen linker_pass_define)
  set(extra_dependencies ${ARGN})
  add_custom_command(
    OUTPUT ${linker_script_gen}
    COMMAND ${CMAKE_COMMAND} -E touch ${linker_script_gen}
    DEPENDS ${extra_dependencies}
    COMMENT "wasm: no linker script (${linker_pass_define})"
  )
endmacro()

function(toolchain_ld_force_undefined_symbols)
  foreach(symbol ${ARGN})
    zephyr_link_libraries(${LINKERFLAGPREFIX},-u,${symbol})
  endforeach()
endfunction()

function(toolchain_ld_link_elf)
  cmake_parse_arguments(
    TOOLCHAIN_LD_LINK_ELF
    ""
    "TARGET_ELF;OUTPUT_MAP;LINKER_SCRIPT"
    "LIBRARIES_PRE_SCRIPT;LIBRARIES_POST_SCRIPT;DEPENDENCIES"
    ${ARGN}
  )

  target_link_libraries(
    ${TOOLCHAIN_LD_LINK_ELF_TARGET_ELF}
    ${TOOLCHAIN_LD_LINK_ELF_LIBRARIES_PRE_SCRIPT}
    ${TOOLCHAIN_LD_LINK_ELF_LIBRARIES_POST_SCRIPT}

    # -fuse-ld makes the clang driver call wasm-ld, and --no-entry keeps it
    # from looking for _start: the host calls z_wasm_boot explicitly.
    -fuse-ld=${WASM_LLD_PATH}/bin/wasm-ld
    -nostdlib
    ${LINKERFLAGPREFIX},--no-entry
    ${LINKERFLAGPREFIX},--export-dynamic
    ${LINKERFLAGPREFIX},--allow-undefined
    ${LINKERFLAGPREFIX},-z,stack-size=${CONFIG_MAIN_STACK_SIZE}
    ${LINKERFLAGPREFIX},--export=__stack_pointer
    ${LINKERFLAGPREFIX},--export=__heap_base
    ${LINKERFLAGPREFIX},--export=__data_end

    ${LINKERFLAGPREFIX},--whole-archive
    ${WHOLE_ARCHIVE_LIBS}
    ${LINKERFLAGPREFIX},--no-whole-archive
    ${NO_WHOLE_ARCHIVE_LIBS}
    $<TARGET_OBJECTS:${OFFSETS_LIB}>
    -L${PROJECT_BINARY_DIR}

    ${TOOLCHAIN_LD_LINK_ELF_DEPENDENCIES}
  )
endfunction()

macro(toolchain_linker_finalize)
endmacro()

function(toolchain_linker_add_compiler_options)
  # Linking runs through the clang driver with -fuse-ld, so the compiler flags
  # that select the target still have to reach it.
  zephyr_link_libraries(${ARGN})
endfunction()

# These generate linker-script fragments for userspace memory partitioning.
# CONFIG_USERSPACE is out of scope and there is no linker script to include
# them from, so there is nothing to configure.
macro(toolchain_ld_configure_files)
endmacro()

function(toolchain_ld_relocation)
endfunction()
