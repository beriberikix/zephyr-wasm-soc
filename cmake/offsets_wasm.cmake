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

  # Matches Zephyr's own default: the header is named after the target, so
  # `offsets` gives offsets.h and `heap_constants` gives heap_constants.h.
  if(NOT DEFINED ARG_HEADER)
    set(ARG_HEADER "${ARG_NAME}.h")
  endif()
  set(lib_name ${ARG_NAME})
  set(output_path ${PROJECT_BINARY_DIR}/include/generated/zephyr/${ARG_HEADER})

  # Build the object as usual: the rest of the build links it, and compiling
  # it is what proves offsets.c is valid in the first place.
  add_library(${lib_name} OBJECT ${ARG_SOURCE})
  # Zephyr passes INCLUDES ${ARCH_DIR}/common/include, and ARCH_DIR is this
  # module, so that path does not exist. gen_offset.h lives in the Zephyr tree.
  target_include_directories(${lib_name} PRIVATE
    ${ARG_INCLUDES}
    ${ZEPHYR_BASE}/arch/common/include
    ${ZEPHYR_BASE}/kernel/include
  )
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
  # Zephyr passes INCLUDES ${ARCH_DIR}/common/include, and ARCH_DIR is this
  # module, so that path does not exist. gen_offset.h lives in the Zephyr tree,
  # so add it explicitly. These are plain CMake values, not generator
  # expressions, so build the flags directly rather than through a genex.
  # Zephyr force-includes the generated Kconfig header rather than passing
  # every CONFIG_ as -D. Without it the architecture is invisible and
  # gcc.h's GEN_ABSOLUTE_SYM chain falls through to its #error.
  # The triple is the whole point: struct layout has to come from the target
  # compiler, not the host. Without it clang builds for the host and the
  # numbers would be wrong even where they compile.
  set(include_flags --flag=--target=${CMAKE_C_COMPILER_TARGET}
                    --flag=-imacros --flag=${AUTOCONF_H})
  foreach(dir ${ARG_INCLUDES} ${ZEPHYR_BASE}/arch/common/include ${ZEPHYR_BASE}/kernel/include)
    if(EXISTS ${dir})
      list(APPEND include_flags --flag=-I${dir})
    endif()
  endforeach()

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
            ${include_flags}
    DEPENDS ${ARG_SOURCE} ${rsp}
    COMMAND_EXPAND_LISTS
    COMMENT "Generating ${ARG_HEADER} for wasm"
  )

  add_custom_target(${lib_name}_h DEPENDS ${output_path})

  # Zephyr's own generator reads a compiled object, which by then has all the
  # generated headers. This one compiles the source itself, at generated-header
  # time, so it has to wait for the syscall headers that kernel_offsets.h pulls
  # in through device.h. That target sits outside zephyr_generated_headers, so
  # depending on it does not close a cycle.
  if(TARGET ${SYSCALL_LIST_H_TARGET})
    add_dependencies(${lib_name}_h ${SYSCALL_LIST_H_TARGET})
  endif()
  add_dependencies(${lib_name} ${lib_name}_h)

  # Note: deliberately NOT depending on zephyr_generated_headers here.
  # zephyr_generated_headers already depends on this target, so taking a
  # dependency the other way closes a cycle that CMake rejects.
  add_dependencies(zephyr_generated_headers ${lib_name}_h)
endfunction()
