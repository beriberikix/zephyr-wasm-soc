# Post-link: run Binaryen's Asyncify over the linked module.
#
# Context switching needs the host to unwind one stack and rewind another, and
# Asyncify is what makes that possible. The transform runs on the whole module
# (spike C: narrowing it breaks any yield reached through an indirect call,
# which is how Zephyr reaches thread entries and init handlers).
#
# Zephyr hardcodes a .elf suffix for the link output, so the link produces a
# wasm module named zephyr.elf and this step writes the real zephyr.wasm.
#
# SPDX-License-Identifier: Apache-2.0

find_program(WASM_OPT wasm-opt PATHS /opt/homebrew/bin ENV PATH)
if(NOT WASM_OPT)
  message(FATAL_ERROR "wasm-opt (Binaryen) not found; it is required to build this board")
endif()

# The name of the final link target is only decided near the end of Zephyr's
# top-level CMakeLists.txt, long after this SoC file is read, so hang the step
# off a deferred call that runs once that directory has been processed.
function(wasm_add_asyncify_step)
  set(wasm_out ${PROJECT_BINARY_DIR}/zephyr.wasm)
  add_custom_command(
    TARGET ${logical_target_for_zephyr_elf} POST_BUILD
    COMMAND ${WASM_OPT}
            --asyncify
            --pass-arg=asyncify-imports@${WASM_ASYNCIFY_IMPORTS}
            $<TARGET_FILE:${logical_target_for_zephyr_elf}> -o ${wasm_out}
    BYPRODUCTS ${wasm_out}
    COMMENT "Asyncify: ${KERNEL_ELF_NAME} -> zephyr.wasm"
  )
endfunction()

set(wasm_in  ${PROJECT_BINARY_DIR}/${KERNEL_ELF_NAME})
set(wasm_out ${PROJECT_BINARY_DIR}/zephyr.wasm)

# Every import that can suspend has to be named, or Asyncify will not treat a
# call to it as a suspension point.
set(asyncify_imports
  zephyr_host.switch_to
  zephyr_host.wait_for_event
)
list(JOIN asyncify_imports "," WASM_ASYNCIFY_IMPORTS)
set(WASM_ASYNCIFY_IMPORTS ${WASM_ASYNCIFY_IMPORTS} CACHE INTERNAL "")

cmake_language(DEFER DIRECTORY "${ZEPHYR_BASE}" CALL wasm_add_asyncify_step)
