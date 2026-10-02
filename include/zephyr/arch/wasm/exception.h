/*
 * SPDX-License-Identifier: Apache-2.0
 */
#ifndef ZEPHYR_INCLUDE_ARCH_WASM_EXCEPTION_H_
#define ZEPHYR_INCLUDE_ARCH_WASM_EXCEPTION_H_

#ifndef _ASMLANGUAGE
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/*
 * There is no hardware exception frame. A wasm trap unwinds straight to the
 * host and cannot be caught or resumed, so anything the kernel wants to report
 * has to be reported before the trap, through the host's fatal import.
 */
struct arch_esf {
	uint32_t reason;
	uint32_t pc;    /* always 0: wasm exposes no program counter */
};

extern void z_wasm_fatal_error(unsigned int reason, const struct arch_esf *esf);

/* It may return, as arm64's does: see z_wasm_fatal_error(). */
#define ARCH_EXCEPT(reason_p)                                   \
	do {                                                    \
		z_wasm_fatal_error((reason_p), NULL);           \
	} while (false)

#ifdef __cplusplus
}
#endif

#endif /* _ASMLANGUAGE */
#endif /* ZEPHYR_INCLUDE_ARCH_WASM_EXCEPTION_H_ */
