/*
 * Time slicing between two threads that never yield.
 *
 * This is the one thing safepoints exist for. Both threads spin at the same
 * priority and never call into the kernel, so on a port without preemption
 * the first one to run would keep the processor forever and the second would
 * never print. With safepoints, the timer interrupt is noticed at a loop
 * back-edge and the scheduler gets to move on.
 *
 * SPDX-License-Identifier: Apache-2.0
 */
#include <zephyr/kernel.h>
#include <zephyr/sys/printk.h>

#define STACKSIZE 4096
#define PRIORITY  5

static volatile uint32_t spins[2];
static volatile bool stop;

static void spin(int id)
{
	/* Deliberately no kernel calls, and no way out but `stop`. If the
	 * scheduler cannot take the processor away, the other thread never
	 * runs at all. */
	while (!stop) {
		spins[id]++;
	}
}

static void a_entry(void *p1, void *p2, void *p3)
{
	ARG_UNUSED(p1); ARG_UNUSED(p2); ARG_UNUSED(p3);
	spin(0);
	printk("a: finished\n");
}

static void b_entry(void *p1, void *p2, void *p3)
{
	ARG_UNUSED(p1); ARG_UNUSED(p2); ARG_UNUSED(p3);
	spin(1);
	printk("b: finished\n");
}

K_THREAD_DEFINE(thread_a, STACKSIZE, a_entry, NULL, NULL, NULL, PRIORITY, 0, 0);
K_THREAD_DEFINE(thread_b, STACKSIZE, b_entry, NULL, NULL, NULL, PRIORITY, 0, 0);

int main(void)
{
	printk("main: two equal-priority spinners, neither yields\n");
	k_msleep(500);
	stop = true;
	/* Let both spinners notice and leave their loops. */
	k_msleep(50);
	printk("main: a=%u b=%u\n", spins[0], spins[1]);
	printk("%s\n", (spins[0] > 0U && spins[1] > 0U)
			? "PASS: both threads ran, so preemption works"
			: "FAIL: one thread monopolised the processor");
	return 0;
}
