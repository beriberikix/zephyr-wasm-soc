/* One object, one section, three entries declared out of priority order.
 * If wasm-ld sorted by symbol or segment name these would come back 10,50,90. */
__attribute__((section("zord"), used)) const int p90 = 90;
__attribute__((section("zord"), used)) const int p10 = 10;
__attribute__((section("zord"), used)) const int p50 = 50;
extern const int __start_zord;
extern const int __stop_zord;
int start_addr(void) { return (int)(long)&__start_zord; }
int stop_addr(void)  { return (int)(long)&__stop_zord; }
int count(void)      { return (int)(&__stop_zord - &__start_zord); }
int at(int i)        { return (&__start_zord)[i]; }
