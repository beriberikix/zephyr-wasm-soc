/* Stands in for arch/wasm/core/offsets/offsets.c. Exercises both shapes:
 * file scope (what most arch offsets.c files use) and inside
 * GEN_ABS_SYM_BEGIN/END (what kernel_offsets.h uses).  *
 * SPDX-License-Identifier: Apache-2.0
 */
typedef struct { void *sp; void *asyncify_buf; } _callee_saved_t;
typedef struct { void *current; unsigned int nested; char *irq_stack; } _cpu_t;
typedef struct { _callee_saved_t callee_saved; void *init_data; char prio; unsigned char flags; } _thread_t;
struct arch_esf { unsigned int reason; unsigned int pc; };

/* The CONFIG_WASM form: a real constant in a data section. */
#define GEN_ABSOLUTE_SYM(name, value) \
	__attribute__((section("z_offsets"), used)) const long name = (long)(value)
#define GEN_OFFSET_SYM(S, M)    GEN_ABSOLUTE_SYM(__##S##_##M##_OFFSET, __builtin_offsetof(S, M))
#define GEN_OFFSET_STRUCT(S, M) GEN_ABSOLUTE_SYM(__struct_##S##_##M##_OFFSET, __builtin_offsetof(struct S, M))
#define GEN_ABS_SYM_BEGIN(name) void name(void); void name(void) {
#define GEN_ABS_SYM_END }

GEN_OFFSET_SYM(_callee_saved_t, sp);
GEN_OFFSET_SYM(_callee_saved_t, asyncify_buf);
GEN_ABSOLUTE_SYM(__callee_saved_t_SIZEOF, sizeof(_callee_saved_t));
GEN_OFFSET_STRUCT(arch_esf, pc);

/* The kernel_offsets.h shape: function scope, so clang mangles the names. */
GEN_ABS_SYM_BEGIN(_OffsetAbsSyms)
#undef GEN_ABSOLUTE_SYM
#define GEN_ABSOLUTE_SYM(name, value) \
	static __attribute__((section("z_offsets"), used)) const long name = (long)(value)
GEN_OFFSET_SYM(_cpu_t, current);
GEN_OFFSET_SYM(_cpu_t, nested);
GEN_OFFSET_SYM(_cpu_t, irq_stack);
GEN_OFFSET_SYM(_thread_t, callee_saved);
GEN_OFFSET_SYM(_thread_t, init_data);
GEN_OFFSET_SYM(_thread_t, prio);
GEN_ABSOLUTE_SYM(__thread_t_SIZEOF, sizeof(_thread_t));
GEN_ABS_SYM_END
