/*
 * SPDX-License-Identifier: Apache-2.0
 *
 * Compiler support routines that clang emits calls to on wasm32 and that
 * nothing else here provides: this toolchain has no compiler-rt for wasm32.
 *
 * Only what something has been found to need is here, each written the way
 * compiler-rt writes it. Picolibc's strtoull() checks for overflow with a
 * 128-bit multiply, and its printf() converts a double with 128-bit shifts.
 */

#include <stdint.h>

typedef __int128 ti_int;
typedef unsigned __int128 tu_int;

/* The low 64 bits of a 64 x 64 multiply, and the high 64 carried out, built
 * from 32-bit halves so that nothing here is itself a 128-bit multiply. */
static tu_int mul_ddi3(uint64_t a, uint64_t b)
{
	const uint64_t lo_mask = UINT32_MAX;
	uint64_t lo = (a & lo_mask) * (b & lo_mask);
	uint64_t t = lo >> 32;

	lo &= lo_mask;
	t += (a >> 32) * (b & lo_mask);
	lo += (t & lo_mask) << 32;
	uint64_t hi = t >> 32;

	t = lo >> 32;
	lo &= lo_mask;
	t += (b >> 32) * (a & lo_mask);
	lo += (t & lo_mask) << 32;
	hi += t >> 32;
	hi += (a >> 32) * (b >> 32);

	return ((tu_int)hi << 64) | lo;
}

/* a * b, modulo 2^128. Signed and unsigned agree on the low 128 bits. */
ti_int __multi3(ti_int a, ti_int b)
{
	uint64_t a_lo = (uint64_t)a, a_hi = (uint64_t)((tu_int)a >> 64);
	uint64_t b_lo = (uint64_t)b, b_hi = (uint64_t)((tu_int)b >> 64);
	tu_int r = mul_ddi3(a_lo, b_lo);
	uint64_t r_hi = (uint64_t)(r >> 64) + a_hi * b_lo + a_lo * b_hi;

	return (ti_int)(((tu_int)r_hi << 64) | (uint64_t)r);
}

/* Shifts of a 128-bit value by 0 to 127, as two 64-bit halves. A shift of 64
 * or more would be undefined on a 64-bit half, so it is split out. */
ti_int __ashlti3(ti_int a, int b)
{
	uint64_t lo = (uint64_t)a, hi = (uint64_t)((tu_int)a >> 64);

	if (b & 64) {
		hi = lo << (b - 64);
		lo = 0;
	} else if (b != 0) {
		hi = (hi << b) | (lo >> (64 - b));
		lo <<= b;
	}
	return (ti_int)(((tu_int)hi << 64) | lo);
}

ti_int __lshrti3(ti_int a, int b)
{
	uint64_t lo = (uint64_t)a, hi = (uint64_t)((tu_int)a >> 64);

	if (b & 64) {
		lo = hi >> (b - 64);
		hi = 0;
	} else if (b != 0) {
		lo = (lo >> b) | (hi << (64 - b));
		hi >>= b;
	}
	return (ti_int)(((tu_int)hi << 64) | lo);
}
