# SPDX-License-Identifier: Apache-2.0
# TOOLCHAIN_ROOT points at this module, so Zephyr looks for its generic
# templates here. They are not toolchain specific; defer to the originals.
include(${ZEPHYR_BASE}/cmake/compiler/compiler_flags_template.cmake)
