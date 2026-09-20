/* Zephyr declares all six init levels. If a build has no SMP entries, does
 * referencing __start_z_init_SMP break the link? */
extern const int __start_z_init_SMP;
extern const int __stop_z_init_SMP;
int empty(void) { return (int)(&__stop_z_init_SMP - &__start_z_init_SMP); }
