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
            --scan-dir ${PROJECT_BINARY_DIR}
            -o ${sections_c}
    DEPENDS ${ZEPHYR_LIBS_PROPERTY} zephyr kernel
    COMMENT "Scanning objects for linker-section symbols"
    VERBATIM
  )
  add_library(wasm_sections OBJECT ${sections_c} ${bounds_c})
  target_link_libraries(wasm_sections PRIVATE zephyr_interface)
  # kernel_internal.h declares the pay-per-use init entry structs the anchors
  # need, and it is a private kernel header.
  target_include_directories(wasm_sections PRIVATE ${ZEPHYR_BASE}/kernel/include)
  target_link_libraries(${logical_target_for_zephyr_elf} $<TARGET_OBJECTS:wasm_sections>)
  add_dependencies(${logical_target_for_zephyr_elf} wasm_sections)
endfunction()

cmake_language(DEFER DIRECTORY "${ZEPHYR_BASE}" CALL wasm_add_sections_step)
