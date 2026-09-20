# Substitute a wasm-aware offsets generator.
#
# Zephyr's zephyr_constants_library() runs scripts/build/gen_offset_header.py,
# which reads SHN_ABS symbols out of an ELF object. Wasm has no absolute
# symbols. Redefining the function here works because the root CMakeLists.txt
# reaches add_subdirectory(arch) well before it declares the offsets library.
#
# SPDX-License-Identifier: Apache-2.0

function(zephyr_constants_library)
  cmake_parse_arguments(ARG "" "NAME;SOURCE;HEADER" "INCLUDES;DEPENDS" ${ARGN})

  if(NOT DEFINED ARG_HEADER)
    set(ARG_HEADER offsets.h)
  endif()
  set(lib_name ${ARG_NAME})
  set(output_path ${PROJECT_BINARY_DIR}/include/generated/zephyr/${ARG_HEADER})

  # Build the object as usual: the rest of the build links it, and compiling
  # it is what proves offsets.c is valid in the first place.
  add_library(${lib_name} OBJECT ${ARG_SOURCE})
  target_include_directories(${lib_name} PRIVATE ${ARG_INCLUDES})
  target_link_libraries(${lib_name} PRIVATE zephyr_interface)

  # The generator has to compile offsets.c with the same flags the kernel is
  # built with, or the struct layout it reports would not be the layout the
  # kernel sees. Those flags are only known at generate time, so write them to
  # a response file rather than trying to thread them through the command line.
  # The generator has to compile offsets.c with the same flags the kernel is
  # built with, or the layout it reports would not be the layout the kernel
  # sees. Those come from zephyr_interface and are only known at generate
  # time, so write them to a response file.
  #
  # Only language-neutral properties go in here. A per-target property such as
  # INCLUDE_DIRECTORIES on an OBJECT library is evaluated once per language,
  # and file(GENERATE) refuses to write the same path with differing content.
  set(rsp ${CMAKE_CURRENT_BINARY_DIR}/${lib_name}_offsets.rsp)
  file(GENERATE OUTPUT ${rsp} CONTENT
    "-I$<JOIN:$<TARGET_PROPERTY:zephyr_interface,INTERFACE_INCLUDE_DIRECTORIES>,\n-I>\n\
-isystem$<JOIN:$<TARGET_PROPERTY:zephyr_interface,INTERFACE_SYSTEM_INCLUDE_DIRECTORIES>,\n-isystem>\n\
-D$<JOIN:$<TARGET_PROPERTY:zephyr_interface,INTERFACE_COMPILE_DEFINITIONS>,\n-D>\n"
  )

  add_custom_command(
    OUTPUT ${output_path}
    COMMAND ${PYTHON_EXECUTABLE}
            ${WASM_MODULE_DIR}/scripts/gen_offsets_wasm.py
            -i ${ARG_SOURCE}
            -o ${output_path}
            --compiler ${CMAKE_C_COMPILER}
            --rsp ${rsp}
            $<$<BOOL:${ARG_INCLUDES}>:--flag=-I$<JOIN:${ARG_INCLUDES},;--flag=-I>>
    DEPENDS ${ARG_SOURCE} ${rsp}
    COMMAND_EXPAND_LISTS
    COMMENT "Generating ${ARG_HEADER} for wasm"
  )

  add_custom_target(${lib_name}_h DEPENDS ${output_path})
  add_dependencies(${lib_name} ${lib_name}_h)

  # Note: deliberately NOT depending on zephyr_generated_headers here.
  # zephyr_generated_headers already depends on this target, so taking a
  # dependency the other way closes a cycle that CMake rejects.
  add_dependencies(zephyr_generated_headers ${lib_name}_h)
endfunction()
