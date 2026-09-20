# SPDX-License-Identifier: Apache-2.0
#
# Every post-link step Zephyr runs assumes ELF: objcopy to bin/hex, readelf for
# the stat file, a memory-usage report parsed out of section headers. None of
# them mean anything for a wasm module.
#
# bintools_template.cmake already defaults each command to an echo, and leaves
# elfconvert_formats empty so the format checks in the root CMakeLists.txt turn
# into warnings rather than failures. Declaring nothing here is therefore the
# whole implementation. The commands are silenced so the build output stays
# readable.

foreach(cmd memusage disassembly elfconvert readelf strip symbols)
  set_property(TARGET bintools PROPERTY ${cmd}_command ${CMAKE_COMMAND} -E true)
  set_property(TARGET bintools PROPERTY ${cmd}_flag "")
  set_property(TARGET bintools PROPERTY ${cmd}_flag_final "")
  set_property(TARGET bintools PROPERTY ${cmd}_flag_infile "")
  set_property(TARGET bintools PROPERTY ${cmd}_flag_outfile "")
endforeach()
