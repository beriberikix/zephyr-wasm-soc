/* SPDX-License-Identifier: Apache-2.0 */
typedef struct { char a; int b; void *c; long long d; } k_thread_t;
#define GEN_ABSOLUTE_SYM(name, value) \
	__asm__(".globl\t" #name "\n\t.equ\t" #name "," #value "\n\t.type\t" #name ",@object")
GEN_ABSOLUTE_SYM(__k_thread_b_OFFSET, 4);
