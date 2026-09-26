/*
 * Which interrupt arrives on which line.
 *
 * There is no interrupt controller: the host raises an interrupt by setting a
 * bit in a word in linear memory, and the guest takes it at the next
 * safepoint. The line number is therefore a convention shared between the
 * guest, the three hosts and the devicetree, and this is where it is written
 * down. host/irq_lines.mjs and host/run_wasmtime.py mirror it and say so.
 *
 * Preprocessor only: the board devicetree includes this file, so nothing here
 * may be C.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

#ifndef ZEPHYR_INCLUDE_ARCH_WASM_WASM_IRQ_LINES_H_
#define ZEPHYR_INCLUDE_ARCH_WASM_WASM_IRQ_LINES_H_

/** System timer. The host raises this when a deadline it was given expires. */
#define WASM_IRQ_TIMER 0

/** GPIO. The host raises this when an input pin changes. */
#define WASM_IRQ_GPIO 1

/** Input. The host raises this when it has queued pointer or key events. */
#define WASM_IRQ_INPUT 2

/** Sensors. The host raises this when it has queued values for the board's
 * emulated sensors. */
#define WASM_IRQ_SENSOR 3

/*
 * 4 to CONFIG_WASM_IRQ_LINES-1 are unused. The pending word is 32 bits and
 * the software ISR table is CONFIG_WASM_IRQ_LINES deep, so the ceiling is 32.
 */

#endif /* ZEPHYR_INCLUDE_ARCH_WASM_WASM_IRQ_LINES_H_ */
