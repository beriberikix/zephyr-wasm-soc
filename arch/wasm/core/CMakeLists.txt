# SPDX-License-Identifier: Apache-2.0

zephyr_library()

zephyr_library_sources(
  cpu_idle.c
  fatal.c
  irq_manage.c
  prep_c.c
  switch.c
  thread.c
)
zephyr_library_sources_ifdef(CONFIG_WASM_INSPECT inspect.c)
