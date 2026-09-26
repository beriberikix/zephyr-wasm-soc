/*
 * Which interrupt arrives on which line.
 *
 * Must match include/zephyr/arch/wasm/wasm_irq_lines.h, which is the
 * authority, and host/run_wasmtime.py, which carries the same values again
 * because it is deliberately a separate implementation.
 *
 * SPDX-License-Identifier: Apache-2.0
 */
export const IRQ = {
  TIMER: 0,
  GPIO: 1,
  INPUT: 2,
  SENSOR: 3,
};
