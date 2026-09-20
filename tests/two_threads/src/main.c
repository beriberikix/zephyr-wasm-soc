/*
 * The smallest thing that proves two threads alternate.
 *
 * samples/synchronization runs one thread and stops, and it does several
 * things at once: static and dynamic threads, semaphores, a busy wait and a
 * sleep. This separates them. Each stage prints, so the output says exactly
 * how far the port gets.
 *
 * SPDX-License-Identifier: Apache-2.0
 */
#include <zephyr/kernel.h>
#include <zephyr/sys/printk.h>

#define STACKSIZE 2048
#define PRIORITY  7

static K_SEM_DEFINE(sem_a, 1, 1);   /* a runs first */
static K_SEM_DEFINE(sem_b, 0, 1);

static void loop(const char *name, struct k_sem *mine, struct k_sem *other)
{
	for (int i = 0; i < 3; i++) {
		k_sem_take(mine, K_FOREVER);
		printk("%s: round %d\n", name, i);
		k_msleep(10);
		k_sem_give(other);
	}
	printk("%s: done\n", name);
}

static void a_entry(void *p1, void *p2, void *p3)
{
	ARG_UNUSED(p1); ARG_UNUSED(p2); ARG_UNUSED(p3);
	loop("a", &sem_a, &sem_b);
}

static void b_entry(void *p1, void *p2, void *p3)
{
	ARG_UNUSED(p1); ARG_UNUSED(p2); ARG_UNUSED(p3);
	loop("b", &sem_b, &sem_a);
}

K_THREAD_DEFINE(thread_a, STACKSIZE, a_entry, NULL, NULL, NULL, PRIORITY, 0, 0);
K_THREAD_DEFINE(thread_b, STACKSIZE, b_entry, NULL, NULL, NULL, PRIORITY, 0, 0);

static void report(const struct k_thread *thread, void *user_data)
{
	ARG_UNUSED(user_data);
	printk("  thread %-10s prio %3d state 0x%02x\n",
	       thread->name[0] ? thread->name : "(unnamed)",
	       thread->base.prio, thread->base.thread_state);
}

int main(void)
{
	/* Does the spacing between entries match what the kernel iterates by? */
	{
		const struct _static_thread_data *prev = NULL;

		printk("sizeof(_static_thread_data) = %u\n",
		       (unsigned)sizeof(struct _static_thread_data));
		STRUCT_SECTION_FOREACH(_static_thread_data, td) {
			printk("  entry at %p", (void *)td);
			if (prev != NULL) {
				printk("  stride %d", (int)((const char *)td - (const char *)prev));
			}
			printk("  prio %d delay %lld\n", (int)td->init_prio,
			       (long long)td->init_delay.ticks);
			prev = td;
		}
	}

	/* What does the kernel think exists, and in what state? */
	k_thread_foreach(report, NULL);

	/* thread_a is stuck in PRESTART. Does starting it by hand help, and
	 * does thread_b, which is already queued, ever get the processor? */
	printk("main: starting thread_a by hand\n");
	k_thread_start(thread_a);

	printk("main: sleeping so the lower-priority threads can run\n");
	k_msleep(200);
	printk("main: done\n");
	return 0;
}
