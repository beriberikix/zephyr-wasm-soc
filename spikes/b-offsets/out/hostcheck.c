#include <stdio.h>
typedef struct { void *sp; void *asyncify_buf; } _callee_saved_t;
typedef struct { _callee_saved_t callee_saved; void *init_data; char prio; unsigned char flags; } _thread_t;
int main(void) { printf("  host: sizeof(_thread_t)=%zu offsetof(prio)=%zu\n",
    sizeof(_thread_t), __builtin_offsetof(_thread_t, prio)); return 0; }
