/* Does wasm-ld synthesise these, the way an ELF linker does? */
extern const int __start_zsec;
extern const int __stop_zsec;
int start_addr(void) { return (int)(long)&__start_zsec; }
int stop_addr(void)  { return (int)(long)&__stop_zsec; }
int count(void)      { return (int)(&__stop_zsec - &__start_zsec); }
int at(int i)        { return (&__start_zsec)[i]; }
