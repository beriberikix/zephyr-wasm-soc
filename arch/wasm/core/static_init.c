/*
 * SPDX-License-Identifier: Apache-2.0
 *
 * C++ static constructors, and C functions marked constructor.
 *
 * Every other target finds them through __zephyr_init_array_start and _end,
 * which the linker script puts around .init_array, and the kernel calls each
 * one from z_static_init_gnu() before main(). wasm-ld has no linker script.
 * It collects .init_array itself, in priority order, into a function it
 * synthesises, __wasm_call_ctors().
 *
 * So the list the kernel walks has one entry, which calls that function,
 * and constructors run at the same point in boot as on any other target.
 * The kernel's loop stops at the first NULL (a toolchain elsewhere pads the
 * array with one), and that is what ends the list here: the two bounds are
 * separate objects, so the end pointer alone could not.
 */

#include <stddef.h>

extern void __wasm_call_ctors(void);

static void run_constructors(void)
{
	__wasm_call_ctors();
}

void (*__zephyr_init_array_start[])(void) = { run_constructors, NULL };
void (*__zephyr_init_array_end[])(void) = { NULL };
