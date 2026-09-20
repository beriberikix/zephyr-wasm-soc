/* Zephyr's kernel/init.c reads `extern const struct init_entry __init_EARLY_start[]`.
 * wasm-ld gives us __start_z_init_EARLY. Can --defsym bridge the two? */
struct init_entry { int prio; int marker; };
__attribute__((section("z_init_EARLY"), used)) const struct init_entry a = { 1, 0xAA };
__attribute__((section("z_init_EARLY"), used)) const struct init_entry b = { 2, 0xBB };
extern const struct init_entry __init_EARLY_start[];
extern const struct init_entry __init_EARLY_end[];
int n(void)     { return (int)(__init_EARLY_end - __init_EARLY_start); }
int mark(int i) { return __init_EARLY_start[i].marker; }
