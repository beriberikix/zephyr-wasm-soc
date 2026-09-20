/* Kernel-shaped module for spike C.
 *
 * The point of the indirect table is that Zephyr is full of indirect calls:
 * SYS_INIT entries, device API pointers, thread entry points, the ISR table.
 * Asyncify cannot see through them, so it must assume any indirect call might
 * reach the yield import. That assumption is what the onlylist exists to undo.
 */
extern void host_yield(void);

static int mix(int x) { return (x * 1103515245 + 12345) & 0x7fffffff; }

static int noyield_0(int x) {
	int a = x * 3, b = a ^ (x >> 3), c = b + mix(a);
	for (int k = 0; k < 4; k++) { c = mix(c ^ k) + b; b ^= c; }
	return c ^ b;
}

static int noyield_1(int x) {
	int a = x * 4, b = a ^ (x >> 3), c = b + mix(a);
	for (int k = 0; k < 4; k++) { c = mix(c ^ k) + b; b ^= c; }
	return c ^ b;
}

static int noyield_2(int x) {
	int a = x * 5, b = a ^ (x >> 3), c = b + mix(a);
	for (int k = 0; k < 4; k++) { c = mix(c ^ k) + b; b ^= c; }
	return c ^ b;
}

static int noyield_3(int x) {
	int a = x * 6, b = a ^ (x >> 3), c = b + mix(a);
	for (int k = 0; k < 4; k++) { c = mix(c ^ k) + b; b ^= c; }
	return c ^ b;
}

static int noyield_4(int x) {
	int a = x * 7, b = a ^ (x >> 3), c = b + mix(a);
	for (int k = 0; k < 4; k++) { c = mix(c ^ k) + b; b ^= c; }
	return c ^ b;
}

static int noyield_5(int x) {
	int a = x * 8, b = a ^ (x >> 3), c = b + mix(a);
	for (int k = 0; k < 4; k++) { c = mix(c ^ k) + b; b ^= c; }
	return c ^ b;
}

static int noyield_6(int x) {
	int a = x * 9, b = a ^ (x >> 3), c = b + mix(a);
	for (int k = 0; k < 4; k++) { c = mix(c ^ k) + b; b ^= c; }
	return c ^ b;
}

static int noyield_7(int x) {
	int a = x * 10, b = a ^ (x >> 3), c = b + mix(a);
	for (int k = 0; k < 4; k++) { c = mix(c ^ k) + b; b ^= c; }
	return c ^ b;
}

static int noyield_8(int x) {
	int a = x * 11, b = a ^ (x >> 3), c = b + mix(a);
	for (int k = 0; k < 4; k++) { c = mix(c ^ k) + b; b ^= c; }
	return c ^ b;
}

static int noyield_9(int x) {
	int a = x * 12, b = a ^ (x >> 3), c = b + mix(a);
	for (int k = 0; k < 4; k++) { c = mix(c ^ k) + b; b ^= c; }
	return c ^ b;
}

static int noyield_10(int x) {
	int a = x * 13, b = a ^ (x >> 3), c = b + mix(a);
	for (int k = 0; k < 4; k++) { c = mix(c ^ k) + b; b ^= c; }
	return c ^ b;
}

static int noyield_11(int x) {
	int a = x * 14, b = a ^ (x >> 3), c = b + mix(a);
	for (int k = 0; k < 4; k++) { c = mix(c ^ k) + b; b ^= c; }
	return c ^ b;
}

static int noyield_12(int x) {
	int a = x * 15, b = a ^ (x >> 3), c = b + mix(a);
	for (int k = 0; k < 4; k++) { c = mix(c ^ k) + b; b ^= c; }
	return c ^ b;
}

static int noyield_13(int x) {
	int a = x * 16, b = a ^ (x >> 3), c = b + mix(a);
	for (int k = 0; k < 4; k++) { c = mix(c ^ k) + b; b ^= c; }
	return c ^ b;
}

static int noyield_14(int x) {
	int a = x * 17, b = a ^ (x >> 3), c = b + mix(a);
	for (int k = 0; k < 4; k++) { c = mix(c ^ k) + b; b ^= c; }
	return c ^ b;
}

static int noyield_15(int x) {
	int a = x * 18, b = a ^ (x >> 3), c = b + mix(a);
	for (int k = 0; k < 4; k++) { c = mix(c ^ k) + b; b ^= c; }
	return c ^ b;
}

static int noyield_16(int x) {
	int a = x * 19, b = a ^ (x >> 3), c = b + mix(a);
	for (int k = 0; k < 4; k++) { c = mix(c ^ k) + b; b ^= c; }
	return c ^ b;
}

static int noyield_17(int x) {
	int a = x * 20, b = a ^ (x >> 3), c = b + mix(a);
	for (int k = 0; k < 4; k++) { c = mix(c ^ k) + b; b ^= c; }
	return c ^ b;
}

static int noyield_18(int x) {
	int a = x * 21, b = a ^ (x >> 3), c = b + mix(a);
	for (int k = 0; k < 4; k++) { c = mix(c ^ k) + b; b ^= c; }
	return c ^ b;
}

static int noyield_19(int x) {
	int a = x * 22, b = a ^ (x >> 3), c = b + mix(a);
	for (int k = 0; k < 4; k++) { c = mix(c ^ k) + b; b ^= c; }
	return c ^ b;
}

static int noyield_20(int x) {
	int a = x * 23, b = a ^ (x >> 3), c = b + mix(a);
	for (int k = 0; k < 4; k++) { c = mix(c ^ k) + b; b ^= c; }
	return c ^ b;
}

static int noyield_21(int x) {
	int a = x * 24, b = a ^ (x >> 3), c = b + mix(a);
	for (int k = 0; k < 4; k++) { c = mix(c ^ k) + b; b ^= c; }
	return c ^ b;
}

static int noyield_22(int x) {
	int a = x * 25, b = a ^ (x >> 3), c = b + mix(a);
	for (int k = 0; k < 4; k++) { c = mix(c ^ k) + b; b ^= c; }
	return c ^ b;
}

static int noyield_23(int x) {
	int a = x * 26, b = a ^ (x >> 3), c = b + mix(a);
	for (int k = 0; k < 4; k++) { c = mix(c ^ k) + b; b ^= c; }
	return c ^ b;
}

static int noyield_24(int x) {
	int a = x * 27, b = a ^ (x >> 3), c = b + mix(a);
	for (int k = 0; k < 4; k++) { c = mix(c ^ k) + b; b ^= c; }
	return c ^ b;
}

static int noyield_25(int x) {
	int a = x * 28, b = a ^ (x >> 3), c = b + mix(a);
	for (int k = 0; k < 4; k++) { c = mix(c ^ k) + b; b ^= c; }
	return c ^ b;
}

static int noyield_26(int x) {
	int a = x * 29, b = a ^ (x >> 3), c = b + mix(a);
	for (int k = 0; k < 4; k++) { c = mix(c ^ k) + b; b ^= c; }
	return c ^ b;
}

static int noyield_27(int x) {
	int a = x * 30, b = a ^ (x >> 3), c = b + mix(a);
	for (int k = 0; k < 4; k++) { c = mix(c ^ k) + b; b ^= c; }
	return c ^ b;
}

static int noyield_28(int x) {
	int a = x * 31, b = a ^ (x >> 3), c = b + mix(a);
	for (int k = 0; k < 4; k++) { c = mix(c ^ k) + b; b ^= c; }
	return c ^ b;
}

static int noyield_29(int x) {
	int a = x * 32, b = a ^ (x >> 3), c = b + mix(a);
	for (int k = 0; k < 4; k++) { c = mix(c ^ k) + b; b ^= c; }
	return c ^ b;
}

static int noyield_30(int x) {
	int a = x * 33, b = a ^ (x >> 3), c = b + mix(a);
	for (int k = 0; k < 4; k++) { c = mix(c ^ k) + b; b ^= c; }
	return c ^ b;
}

static int noyield_31(int x) {
	int a = x * 34, b = a ^ (x >> 3), c = b + mix(a);
	for (int k = 0; k < 4; k++) { c = mix(c ^ k) + b; b ^= c; }
	return c ^ b;
}

static int noyield_32(int x) {
	int a = x * 35, b = a ^ (x >> 3), c = b + mix(a);
	for (int k = 0; k < 4; k++) { c = mix(c ^ k) + b; b ^= c; }
	return c ^ b;
}

static int noyield_33(int x) {
	int a = x * 36, b = a ^ (x >> 3), c = b + mix(a);
	for (int k = 0; k < 4; k++) { c = mix(c ^ k) + b; b ^= c; }
	return c ^ b;
}

static int noyield_34(int x) {
	int a = x * 37, b = a ^ (x >> 3), c = b + mix(a);
	for (int k = 0; k < 4; k++) { c = mix(c ^ k) + b; b ^= c; }
	return c ^ b;
}

static int noyield_35(int x) {
	int a = x * 38, b = a ^ (x >> 3), c = b + mix(a);
	for (int k = 0; k < 4; k++) { c = mix(c ^ k) + b; b ^= c; }
	return c ^ b;
}

static int noyield_36(int x) {
	int a = x * 39, b = a ^ (x >> 3), c = b + mix(a);
	for (int k = 0; k < 4; k++) { c = mix(c ^ k) + b; b ^= c; }
	return c ^ b;
}

static int noyield_37(int x) {
	int a = x * 40, b = a ^ (x >> 3), c = b + mix(a);
	for (int k = 0; k < 4; k++) { c = mix(c ^ k) + b; b ^= c; }
	return c ^ b;
}

static int noyield_38(int x) {
	int a = x * 41, b = a ^ (x >> 3), c = b + mix(a);
	for (int k = 0; k < 4; k++) { c = mix(c ^ k) + b; b ^= c; }
	return c ^ b;
}

static int noyield_39(int x) {
	int a = x * 42, b = a ^ (x >> 3), c = b + mix(a);
	for (int k = 0; k < 4; k++) { c = mix(c ^ k) + b; b ^= c; }
	return c ^ b;
}

static int noyield_40(int x) {
	int a = x * 43, b = a ^ (x >> 3), c = b + mix(a);
	for (int k = 0; k < 4; k++) { c = mix(c ^ k) + b; b ^= c; }
	return c ^ b;
}

static int noyield_41(int x) {
	int a = x * 44, b = a ^ (x >> 3), c = b + mix(a);
	for (int k = 0; k < 4; k++) { c = mix(c ^ k) + b; b ^= c; }
	return c ^ b;
}

static int noyield_42(int x) {
	int a = x * 45, b = a ^ (x >> 3), c = b + mix(a);
	for (int k = 0; k < 4; k++) { c = mix(c ^ k) + b; b ^= c; }
	return c ^ b;
}

static int noyield_43(int x) {
	int a = x * 46, b = a ^ (x >> 3), c = b + mix(a);
	for (int k = 0; k < 4; k++) { c = mix(c ^ k) + b; b ^= c; }
	return c ^ b;
}

static int noyield_44(int x) {
	int a = x * 47, b = a ^ (x >> 3), c = b + mix(a);
	for (int k = 0; k < 4; k++) { c = mix(c ^ k) + b; b ^= c; }
	return c ^ b;
}

static int noyield_45(int x) {
	int a = x * 48, b = a ^ (x >> 3), c = b + mix(a);
	for (int k = 0; k < 4; k++) { c = mix(c ^ k) + b; b ^= c; }
	return c ^ b;
}

static int noyield_46(int x) {
	int a = x * 49, b = a ^ (x >> 3), c = b + mix(a);
	for (int k = 0; k < 4; k++) { c = mix(c ^ k) + b; b ^= c; }
	return c ^ b;
}

static int noyield_47(int x) {
	int a = x * 50, b = a ^ (x >> 3), c = b + mix(a);
	for (int k = 0; k < 4; k++) { c = mix(c ^ k) + b; b ^= c; }
	return c ^ b;
}

static int noyield_48(int x) {
	int a = x * 51, b = a ^ (x >> 3), c = b + mix(a);
	for (int k = 0; k < 4; k++) { c = mix(c ^ k) + b; b ^= c; }
	return c ^ b;
}

static int noyield_49(int x) {
	int a = x * 52, b = a ^ (x >> 3), c = b + mix(a);
	for (int k = 0; k < 4; k++) { c = mix(c ^ k) + b; b ^= c; }
	return c ^ b;
}

static int noyield_50(int x) {
	int a = x * 53, b = a ^ (x >> 3), c = b + mix(a);
	for (int k = 0; k < 4; k++) { c = mix(c ^ k) + b; b ^= c; }
	return c ^ b;
}

static int noyield_51(int x) {
	int a = x * 54, b = a ^ (x >> 3), c = b + mix(a);
	for (int k = 0; k < 4; k++) { c = mix(c ^ k) + b; b ^= c; }
	return c ^ b;
}

static int noyield_52(int x) {
	int a = x * 55, b = a ^ (x >> 3), c = b + mix(a);
	for (int k = 0; k < 4; k++) { c = mix(c ^ k) + b; b ^= c; }
	return c ^ b;
}

static int noyield_53(int x) {
	int a = x * 56, b = a ^ (x >> 3), c = b + mix(a);
	for (int k = 0; k < 4; k++) { c = mix(c ^ k) + b; b ^= c; }
	return c ^ b;
}

static int noyield_54(int x) {
	int a = x * 57, b = a ^ (x >> 3), c = b + mix(a);
	for (int k = 0; k < 4; k++) { c = mix(c ^ k) + b; b ^= c; }
	return c ^ b;
}

static int noyield_55(int x) {
	int a = x * 58, b = a ^ (x >> 3), c = b + mix(a);
	for (int k = 0; k < 4; k++) { c = mix(c ^ k) + b; b ^= c; }
	return c ^ b;
}

static int noyield_56(int x) {
	int a = x * 59, b = a ^ (x >> 3), c = b + mix(a);
	for (int k = 0; k < 4; k++) { c = mix(c ^ k) + b; b ^= c; }
	return c ^ b;
}

static int noyield_57(int x) {
	int a = x * 60, b = a ^ (x >> 3), c = b + mix(a);
	for (int k = 0; k < 4; k++) { c = mix(c ^ k) + b; b ^= c; }
	return c ^ b;
}

static int noyield_58(int x) {
	int a = x * 61, b = a ^ (x >> 3), c = b + mix(a);
	for (int k = 0; k < 4; k++) { c = mix(c ^ k) + b; b ^= c; }
	return c ^ b;
}

static int noyield_59(int x) {
	int a = x * 62, b = a ^ (x >> 3), c = b + mix(a);
	for (int k = 0; k < 4; k++) { c = mix(c ^ k) + b; b ^= c; }
	return c ^ b;
}

/* One indirect-callable function that CAN yield. In Zephyr this is the norm,
 * not the exception: a thread entry or an init handler that calls k_msleep. */
static int sleeper(int x) { host_yield(); return mix(x); }

typedef int (*op_t)(int);
/* Indirect, the way a Zephyr device API or init entry is. */
static op_t table[] = {
	sleeper,
	noyield_0,
	noyield_1,
	noyield_2,
	noyield_3,
	noyield_4,
	noyield_5,
	noyield_6,
	noyield_7,
	noyield_8,
	noyield_9,
	noyield_10,
	noyield_11,
	noyield_12,
	noyield_13,
	noyield_14,
	noyield_15,
	noyield_16,
	noyield_17,
	noyield_18,
	noyield_19,
	noyield_20,
	noyield_21,
	noyield_22,
	noyield_23,
	noyield_24,
	noyield_25,
	noyield_26,
	noyield_27,
	noyield_28,
	noyield_29,
	noyield_30,
	noyield_31,
	noyield_32,
	noyield_33,
	noyield_34,
	noyield_35,
	noyield_36,
	noyield_37,
	noyield_38,
	noyield_39,
	noyield_40,
	noyield_41,
	noyield_42,
	noyield_43,
	noyield_44,
	noyield_45,
	noyield_46,
	noyield_47,
	noyield_48,
	noyield_49,
	noyield_50,
	noyield_51,
	noyield_52,
	noyield_53,
	noyield_54,
	noyield_55,
	noyield_56,
	noyield_57,
	noyield_58,
	noyield_59,
};

int compute(int rounds)
{
	int acc = 1;
	for (int r = 0; r < rounds; r++)
		for (int i = 0; i < 60; i++)
			acc ^= table[i](acc + i);
	return acc;
}

static int work(int depth, int seed)
{
	if (depth == 0) return mix(seed);
	int local = mix(seed + depth);
	return local ^ work(depth - 1, local);
}

int yielding(int iters)
{
	int checksum = 0;
	for (int i = 0; i < iters; i++) {
		checksum ^= work(3, checksum + i);
		host_yield();
	}
	return checksum;
}
