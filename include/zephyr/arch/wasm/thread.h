/*
 * Per-thread architecture state.
 * SPDX-License-Identifier: Apache-2.0
 */
#ifndef ZEPHYR_INCLUDE_ARCH_WASM_THREAD_H_
#define ZEPHYR_INCLUDE_ARCH_WASM_THREAD_H_

#ifndef _ASMLANGUAGE
#include <stdint.h>

/*
 * A wasm thread is two regions carved out of one K_THREAD_STACK object:
 *
 *   low   +------------------+  <- stack_base
 *         |  C shadow stack  |     grows down from asyncify_buf
 *         +------------------+  <- asyncify_buf
 *         | Asyncify buffer  |     holds unwound wasm frames
 *   high  +------------------+  <- asyncify_end
 *
 * Asyncify saves the wasm frames but knows nothing about __stack_pointer, so
 * the arch saves and restores that itself on every switch. See DESIGN.md D8.
 */
struct _callee_saved {
	uint32_t sp;            /* saved __stack_pointer */
	uint32_t asyncify_buf;  /* start of this thread's Asyncify buffer */
	uint32_t asyncify_end;  /* one past its last byte */
	uint32_t fresh;         /* non-zero until the thread first runs */
};

typedef struct _callee_saved _callee_saved_t;

struct _thread_arch {
	uint32_t irq_lock_key;
};

typedef struct _thread_arch _thread_arch_t;

#endif /* _ASMLANGUAGE */
#endif /* ZEPHYR_INCLUDE_ARCH_WASM_THREAD_H_ */
