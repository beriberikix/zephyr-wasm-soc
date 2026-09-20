/* Spike C: several "threads", each with its own shadow-stack region and its
 * own Asyncify buffer, switching under a host-side driver loop.
 *
 * This is the shape arch/wasm will use. Each Zephyr thread stack object gets
 * split in two: the low part is the C shadow stack that __stack_pointer walks,
 * the high part is the Asyncify buffer that holds the unwound wasm frames.
 * The host swaps both when it switches.
 */
#define NTHREADS      4
#define STACK_BYTES   2048
#define ASYNCIFY_BYTES 4096
#define SLOT_BYTES    (STACK_BYTES + ASYNCIFY_BYTES)

/* One arena so the host can compute every region from a single base. */
static unsigned char arena[NTHREADS * SLOT_BYTES] __attribute__((aligned(16)));

/* The host drives switching; this import is the suspension point. */
extern void host_yield(void);
extern void host_log(int thread_id, int iteration, int checksum);

int arena_base(void)   { return (int)(long)arena; }
int slot_bytes(void)   { return SLOT_BYTES; }
int stack_bytes(void)  { return STACK_BYTES; }
int nthreads(void)     { return NTHREADS; }

/* A little real work, so the Asyncify instrumentation has something to cost.
 * Deliberately recursive and deliberately holding locals across the yield, so
 * the saved state is not trivial. */
static int mix(int x) { return (x * 1103515245 + 12345) & 0x7fffffff; }

static int work(int depth, int seed)
{
	if (depth == 0) {
		return mix(seed);
	}
	int local = mix(seed + depth);
	return local ^ work(depth - 1, local);
}

/* Yield from N frames down, so the spike can measure how Asyncify scales with
 * the depth of the stack it has to copy. */
static int yield_at_depth(int depth, int seed)
{
	/* The volatile slot forces a real stack frame. Without it clang turns
	 * this into an accumulator loop, because xor is associative, and the
	 * recursion disappears along with the thing being measured. */
	volatile int pad;

	pad = seed;
	if (depth == 0) {
		host_yield();
		return mix((int)pad);
	}
	int deeper = yield_at_depth(depth - 1, mix(seed + depth));

	return deeper ^ (int)pad;
}

static int g_depth = 0;
void set_yield_depth(int d) { g_depth = d; }

/* Held across host_yield() to prove locals survive an unwind/rewind. */
int thread_main(int id)
{
	int checksum = id * 7919;

	for (int i = 0; i < 1000000; i++) {
		int before = checksum;

		checksum ^= work(3, checksum + i);
		checksum ^= yield_at_depth(g_depth, checksum);  /* <- unwinds here */

		/* If locals did not survive, this relationship breaks. */
		if (before == checksum && i > 0) {
			host_log(id, i, -1);
		}
		host_log(id, i, checksum);
	}
	return checksum;
}
