typedef struct { void *sp; void *asyncify_buf; } _callee_saved_t;
typedef struct { void *current; unsigned int nested; char *irq_stack; } _cpu_t;
typedef struct { _callee_saved_t callee_saved; void *init_data; char prio; unsigned char flags; } _thread_t;
struct arch_esf { unsigned int reason; unsigned int pc; };
#define O(s,m) __builtin_offsetof(s,m)
int v(int i) {
  const int t[] = { O(_callee_saved_t,sp), O(_callee_saved_t,asyncify_buf), (int)sizeof(_callee_saved_t),
                    O(struct arch_esf,pc), O(_cpu_t,current), O(_cpu_t,nested), O(_cpu_t,irq_stack),
                    O(_thread_t,callee_saved), O(_thread_t,init_data), O(_thread_t,prio), (int)sizeof(_thread_t) };
  return t[i];
}
