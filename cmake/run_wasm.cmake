# `west build -t run`, and the target twister drives.
#
# This cannot live in board.cmake: that runs before Zephyr's own directory has
# been added, so a deferred call there has nowhere to attach, and the name of
# the final link target is not known until much later either.
#
# SPDX-License-Identifier: Apache-2.0

find_program(WASM_NODE_EXECUTABLE node REQUIRED)

function(wasm_add_run_target)
  add_custom_target(run
    COMMAND ${WASM_NODE_EXECUTABLE} ${WASM_MODULE_DIR}/host/run.mjs
            $<$<BOOL:${CONFIG_WASM_RUN_REALTIME}>:--realtime>
            --max-time ${CONFIG_WASM_RUN_MAX_TIME_MS}
            ${PROJECT_BINARY_DIR}/zephyr.wasm
    DEPENDS ${logical_target_for_zephyr_elf}
    WORKING_DIRECTORY ${APPLICATION_BINARY_DIR}
    USES_TERMINAL
  )
endfunction()

cmake_language(DEFER DIRECTORY "${ZEPHYR_BASE}" CALL wasm_add_run_target)
