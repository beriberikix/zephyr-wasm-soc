# SPDX-License-Identifier: Apache-2.0

zephyr_library()

zephyr_library_sources(
  builtins.c
  cpu_idle.c
  fatal.c
  irq_manage.c
  prep_c.c
  switch.c
  thread.c
)
zephyr_library_sources_ifdef(CONFIG_WASM_INSPECT inspect.c)
zephyr_library_sources_ifdef(CONFIG_REBOOT reboot.c)
zephyr_library_sources_ifdef(CONFIG_STATIC_INIT_GNU static_init.c)

# Inspection asks the kernel how long a thread's timeout has left, and that
# lookup walks the timeout list. The safepoint pass can only leave out a
# function it can name, and it names them by export (inspect.c says why).
if(CONFIG_WASM_INSPECT AND CONFIG_SYS_CLOCK_EXISTS)
  zephyr_link_libraries(-Wl,--export=z_timeout_remaining)
endif()
