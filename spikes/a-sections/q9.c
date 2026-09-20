/* kernel/init.c walks levels[level] .. levels[level+1], so every init level
 * must be contiguous in memory and in level order. If a generated file
 * defines the per-level arrays adjacently in one TU, do they land contiguous? */
struct init_entry { int fn; int dev; };
#define SEC __attribute__((section("z_init"), used, aligned(4)))

SEC const struct init_entry __init_EARLY_start[]        = { {1,0}, {2,0} };
SEC const struct init_entry __init_PRE_KERNEL_1_start[] = { {3,0} };
SEC const struct init_entry __init_PRE_KERNEL_2_start[] = { {4,0}, {5,0} };
SEC const struct init_entry __init_POST_KERNEL_start[]  = { {6,0} };
SEC const struct init_entry __init_APPLICATION_start[]  = { {7,0} };
SEC const struct init_entry __init_end[]                = { {0,0} };

int addr(int which) {
  const struct init_entry *t[] = { __init_EARLY_start, __init_PRE_KERNEL_1_start,
    __init_PRE_KERNEL_2_start, __init_POST_KERNEL_start, __init_APPLICATION_start, __init_end };
  return (int)(long)t[which];
}
/* Walk it exactly the way z_sys_init_run_level does. */
int walk(int level) {
  const struct init_entry *t[] = { __init_EARLY_start, __init_PRE_KERNEL_1_start,
    __init_PRE_KERNEL_2_start, __init_POST_KERNEL_start, __init_APPLICATION_start, __init_end };
  int sum = 0;
  for (const struct init_entry *e = t[level]; e < t[level+1]; e++) sum = sum*10 + e->fn;
  return sum;
}
