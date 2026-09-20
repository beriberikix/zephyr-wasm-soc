/* Wasm-native GEN_ABSOLUTE_SYM: the symbol name carries the offset name and
 * the value sits in a data segment the build can read back. Matches Zephyr's
 * calling convention, where S is a typedef name and GEN_OFFSET_STRUCT takes
 * a struct tag. */
typedef struct { char a; int b; void *c; long long d; } k_thread_t;
struct arch_esf { int pc; int sp; };

#define GEN_ABSOLUTE_SYM(name, value) \
	__attribute__((section("z_offsets"), used)) const long name = (long)(value)
#define GEN_OFFSET_SYM(S, M)    GEN_ABSOLUTE_SYM(__##S##_##M##_OFFSET, __builtin_offsetof(S, M))
#define GEN_OFFSET_STRUCT(S, M) GEN_ABSOLUTE_SYM(__struct_##S##_##M##_OFFSET, __builtin_offsetof(struct S, M))

GEN_OFFSET_SYM(k_thread_t, a);
GEN_OFFSET_SYM(k_thread_t, b);
GEN_OFFSET_SYM(k_thread_t, c);
GEN_OFFSET_SYM(k_thread_t, d);
GEN_ABSOLUTE_SYM(__k_thread_t_SIZEOF, sizeof(k_thread_t));
GEN_OFFSET_STRUCT(arch_esf, sp);
