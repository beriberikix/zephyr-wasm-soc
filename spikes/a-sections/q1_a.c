/* Two objects contributing to one C-identifier-named section. */
__attribute__((section("zsec"), used)) const int a_first  = 0xA1;
__attribute__((section("zsec"), used)) const int a_second = 0xA2;
