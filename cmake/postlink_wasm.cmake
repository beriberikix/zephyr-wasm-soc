# Post-link: safepoint instrumentation, then Asyncify.
#
# Order matters. The safepoint pass inserts calls that may suspend, because
# taking an interrupt there can switch threads, so Asyncify has to run after it
# and see them.
#
# Zephyr hardcodes a .elf suffix for the link output, so the link produces a
# wasm module named zephyr.elf and these steps write the real zephyr.wasm.
#
# SPDX-License-Identifier: Apache-2.0

find_program(WASM_OPT wasm-opt PATHS /opt/homebrew/bin ENV PATH)
if(NOT WASM_OPT)
  message(FATAL_ERROR "wasm-opt (Binaryen) not found; it is required to build this board")
endif()

if(CONFIG_WASM_SAFEPOINTS)
  find_program(WASM2WAT wasm2wat PATHS /opt/homebrew/bin ENV PATH)
  find_program(WAT2WASM wat2wasm PATHS /opt/homebrew/bin ENV PATH)
  if(NOT WASM2WAT OR NOT WAT2WASM)
    message(FATAL_ERROR "wasm2wat/wat2wasm (wabt) are required for CONFIG_WASM_SAFEPOINTS")
  endif()
endif()

# Every import that can suspend has to be named, or Asyncify will not treat a
# call to it as a suspension point.
set(asyncify_imports
  zephyr_host.switch_to
  zephyr_host.wait_for_event
)
list(JOIN asyncify_imports "," WASM_ASYNCIFY_IMPORTS)
set(WASM_ASYNCIFY_IMPORTS ${WASM_ASYNCIFY_IMPORTS} CACHE INTERNAL "")

# The name of the final link target is only decided near the end of Zephyr's
# top-level CMakeLists.txt, long after this SoC file is read, so hang the steps
# off a deferred call that runs once that directory has been processed.
function(wasm_add_asyncify_step)
  set(wasm_out ${PROJECT_BINARY_DIR}/zephyr.wasm)
  set(linked $<TARGET_FILE:${logical_target_for_zephyr_elf}>)

  if(CONFIG_WASM_SAFEPOINTS)
    set(wat_in  ${PROJECT_BINARY_DIR}/zephyr.wat)
    set(wat_out ${PROJECT_BINARY_DIR}/zephyr.safepoints.wat)
    set(instrumented ${PROJECT_BINARY_DIR}/zephyr.safepoints.wasm)
    add_custom_command(
      TARGET ${logical_target_for_zephyr_elf} POST_BUILD
      COMMAND ${WASM2WAT} ${linked} -o ${wat_in}
      COMMAND ${PYTHON_EXECUTABLE} ${WASM_MODULE_DIR}/scripts/instrument_safepoints.py
              -i ${wat_in} -o ${wat_out}
      COMMAND ${WAT2WASM} ${wat_out} -o ${instrumented}
      COMMAND ${WASM_OPT} --asyncify
              --pass-arg=asyncify-imports@${WASM_ASYNCIFY_IMPORTS}
              ${instrumented} -o ${wasm_out}
      BYPRODUCTS ${wasm_out} ${wat_in} ${wat_out} ${instrumented}
      COMMENT "Safepoints and Asyncify: ${KERNEL_ELF_NAME} -> zephyr.wasm"
    )
  else()
    add_custom_command(
      TARGET ${logical_target_for_zephyr_elf} POST_BUILD
      COMMAND ${WASM_OPT} --asyncify
              --pass-arg=asyncify-imports@${WASM_ASYNCIFY_IMPORTS}
              ${linked} -o ${wasm_out}
      BYPRODUCTS ${wasm_out}
      COMMENT "Asyncify: ${KERNEL_ELF_NAME} -> zephyr.wasm"
    )
  endif()
endfunction()

cmake_language(DEFER DIRECTORY "${ZEPHYR_BASE}" CALL wasm_add_asyncify_step)
