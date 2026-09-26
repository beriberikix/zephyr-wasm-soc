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
