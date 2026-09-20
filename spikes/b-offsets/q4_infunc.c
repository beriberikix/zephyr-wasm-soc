/* kernel_offsets.h wraps everything in GEN_ABS_SYM_BEGIN/END, which opens a
 * function body, so the wasm form of GEN_ABSOLUTE_SYM must work there too. */
typedef struct { char a; int b; void *c; long long d; } k_thread_t;
#define GEN_ABSOLUTE_SYM(name, value) \
	static __attribute__((section("z_offsets"), used)) const long name = (long)(value)
#define GEN_OFFSET_SYM(S, M) GEN_ABSOLUTE_SYM(__##S##_##M##_OFFSET, __builtin_offsetof(S, M))
#define GEN_ABS_SYM_BEGIN(name) void name(void); void name(void) {
#define GEN_ABS_SYM_END }

GEN_ABS_SYM_BEGIN(_OffsetAbsSyms)
GEN_OFFSET_SYM(k_thread_t, b);
GEN_OFFSET_SYM(k_thread_t, d);
GEN_ABSOLUTE_SYM(__k_thread_t_SIZEOF, sizeof(k_thread_t));
GEN_ABS_SYM_END
