/*
 * Offset definitions for the wasm arch.
 *
 * Nothing here is consumed by assembly, because this arch has none. The file
 * exists because the build generates zephyr/offsets.h from a fixed path, and
 * because the kernel's own offsets are cheap to keep correct.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

#include <gen_offset.h>
#include <kernel_arch_data.h>
#include <kernel_offsets.h>

GEN_OFFSET_SYM(_callee_saved_t, sp);
GEN_OFFSET_SYM(_callee_saved_t, asyncify_buf);
GEN_OFFSET_SYM(_callee_saved_t, asyncify_end);
GEN_OFFSET_SYM(_callee_saved_t, fresh);
GEN_ABSOLUTE_SYM(__callee_saved_t_SIZEOF, sizeof(_callee_saved_t));

GEN_ABS_SYM_END
