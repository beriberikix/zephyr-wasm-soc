# SPDX-License-Identifier: Apache-2.0
# Module-level sources: the host-backed drivers. The arch, SoC and board are
# picked up through arch_root / soc_root / board_root in zephyr/module.yml.

zephyr_include_directories(include)
add_subdirectory(drivers)
