/* Zephyr's section names are dotted, which are not C identifiers, so no
 * linker can synthesise __start_/__stop_ for them. The question that matters
 * is whether the (a) approach works: rename to an identifier and keep the
 * priority encoded in the name, then see whether ordering is recoverable.
 *
 * Here three SYS_INIT-like entries land in ONE identifier-named section, in
 * an order that does not match their priority. */
struct init_entry { int prio; int marker; };

__attribute__((section("z_init_POST_KERNEL"), used))
const struct init_entry e_p90 = { 90, 0xE90 };
__attribute__((section("z_init_POST_KERNEL"), used))
const struct init_entry e_p10 = { 10, 0xE10 };
__attribute__((section("z_init_POST_KERNEL"), used))
const struct init_entry e_p50 = { 50, 0xE50 };

extern const struct init_entry __start_z_init_POST_KERNEL;
extern const struct init_entry __stop_z_init_POST_KERNEL;
int start_addr(void) { return (int)(long)&__start_z_init_POST_KERNEL; }
int stop_addr(void)  { return (int)(long)&__stop_z_init_POST_KERNEL; }
int count(void)      { return (int)(&__stop_z_init_POST_KERNEL - &__start_z_init_POST_KERNEL); }
int at(int i)        { return (&__start_z_init_POST_KERNEL)[i].prio; }
