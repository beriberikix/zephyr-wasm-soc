/*
 * Placeholder.
 *
 * Zephyr's root CMakeLists.txt fails the build outright if LINKER_SCRIPT does
 * not name an existing file, and there is no "no linker script" path. wasm-ld
 * takes no linker script at all, so this file exists only to satisfy that
 * check and is never passed to the linker.
 *
 * SPDX-License-Identifier: Apache-2.0
 */
