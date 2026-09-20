/*
 * What safepoints cost on ordinary work.
 *
 * A fixed amount of loop-heavy computation in one thread, with no kernel calls
 * in the hot path. Build it with CONFIG_WASM_SAFEPOINTS on and off and compare
 * how long the host takes; the difference is the price of checking for a
 * pending interrupt at every loop back-edge.
 *
 * SPDX-License-Identifier: Apache-2.0
 */
#include <zephyr/kernel.h>
#include <zephyr/sys/printk.h>

#define ROUNDS 8000
#define INNER  100000

static volatile uint32_t sink;

int main(void)
{
	uint32_t acc = 1;

	for (int r = 0; r < ROUNDS; r++) {
		for (int i = 0; i < INNER; i++) {
			acc = acc * 1103515245U + 12345U;
			acc ^= acc >> 7;
		}
	}
	sink = acc;
	printk("done acc=%u\n", acc);
	return 0;
}
