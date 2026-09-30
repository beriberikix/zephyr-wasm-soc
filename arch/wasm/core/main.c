/*
 * Reaching an application's main(argc, argv).
 * SPDX-License-Identifier: Apache-2.0
 *
 * On wasm, clang gives main a different symbol for each signature, because
 * a call has to match its callee's type exactly:
 *
 *   int main(void)              defines __original_main
 *   int main(int, char **)      defines __main_argc_argv (main if freestanding)
 *
 * and the kernel's call, extern int main(void), refers to __original_main.
 * Elsewhere both forms are one symbol, main, and a sample written the second
 * way -- posix/eventfd, after the Linux manpage -- runs. Here its main was
 * never linked to the call, the kernel's weak default ran instead, and the
 * sample printed nothing at all.
 *
 * This is a second weak default. The arch library is linked whole, ahead of
 * the kernel's, so it is the one the call finds when the application has no
 * main(void), and an application that has one still overrides it. It passes
 * the arguments Zephyr has, which is none.
 */

#include <stddef.h>
#include <zephyr/toolchain.h>

/* Declared as the application would define it, so it gets the same symbol
 * in the same mode: __main_argc_argv hosted, main freestanding. Weak, so an
 * application with no main at all still links.
 */
extern int main(int argc, char **argv) __weak;

__weak int z_wasm_main(void) __asm__("__original_main");

__weak int z_wasm_main(void)
{
	static char *argv[] = { NULL };

	if (main == NULL) {
		return 0;
	}
	return main(0, argv);
}
