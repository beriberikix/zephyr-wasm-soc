# The two-pass half of the linker-section story.
#
# wasm-ld has no linker script, so the symbols Zephyr's script would define do
# not exist. This scans the compiled objects for the sections Zephyr encodes
# level and priority into, generates a C file that supplies those symbols, and
# links it in. See DESIGN.md D6 and spikes/a-sections.
#
# SPDX-License-Identifier: Apache-2.0

find_program(WASM_OBJDUMP wasm-objdump PATHS /opt/homebrew/bin ENV PATH)
if(NOT WASM_OBJDUMP)
  message(FATAL_ERROR "wasm-objdump (wabt) not found; it is required to build this board")
endif()

# The generator unpacks the archives Zephyr's libraries are built into, so it
# needs an archiver that understands wasm objects. Looked for beside clang
# rather than left to PATH, where the host's own ar would be found first and
# would fail on the members it cannot read.
get_filename_component(_wasm_llvm_bin ${CMAKE_C_COMPILER} DIRECTORY)
find_program(WASM_AR llvm-ar HINTS ${_wasm_llvm_bin} PATHS /opt/homebrew/opt/llvm/bin ENV PATH)
if(NOT WASM_AR)
  message(FATAL_ERROR "llvm-ar not found; it is required to build this board")
endif()

function(wasm_add_sections_step)
  # Computed here, not at file scope: the deferred call runs in Zephyr's
  # top-level directory scope, where a plain variable set from a SoC file is
  # not visible.
  set(sections_c ${PROJECT_BINARY_DIR}/wasm_sections.c)
  set(bounds_c ${PROJECT_BINARY_DIR}/wasm_section_bounds.c)

  # Runs after every Zephyr library is compiled, because it reads their
  # objects. Scanning the build tree rather than naming targets keeps this
  # working whatever set of libraries a given application pulls in.
  add_custom_command(
    OUTPUT ${sections_c} ${bounds_c}
    COMMAND ${PYTHON_EXECUTABLE}
            ${WASM_MODULE_DIR}/scripts/gen_sections_wasm.py
            --objdump ${WASM_OBJDUMP}
            --ar ${WASM_AR}
            # The whole build tree, not just the zephyr subdirectory: the
            # application's own objects sit outside it, and they are where
            # K_THREAD_DEFINE and most SYS_INIT entries in a sample live.
            --scan-dir ${CMAKE_BINARY_DIR}
            -o ${sections_c}
    DEPENDS ${ZEPHYR_LIBS_PROPERTY} zephyr kernel
    COMMENT "Scanning objects for linker-section symbols"
    VERBATIM
  )
  add_library(wasm_sections OBJECT ${sections_c})
  target_link_libraries(wasm_sections PRIVATE zephyr_interface)
  target_include_directories(wasm_sections PRIVATE ${ZEPHYR_BASE}/kernel/include)
  target_link_libraries(${logical_target_for_zephyr_elf} $<TARGET_OBJECTS:wasm_sections>)
  add_dependencies(${logical_target_for_zephyr_elf} wasm_sections)

  # The iterable-section layout has to be the first thing wasm-ld sees: it
  # places output segments in the order it first meets their names, so this
  # file decides the order only if it is ahead of every archive. A source of
  # the executable itself is compiled into the objects that open the link
  # line, ahead of anything named as a library. It includes no headers and
  # needs no flags beyond the target's. check_sections_wasm.py verifies the
  # result from the link map.
  target_sources(${logical_target_for_zephyr_elf} PRIVATE ${bounds_c})
endfunction()

cmake_language(DEFER DIRECTORY "${ZEPHYR_BASE}" CALL wasm_add_sections_step)
