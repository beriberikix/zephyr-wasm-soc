#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Build the wasm32 sysroot a full C++ standard library needs: picolibc,
# libc++ and libc++abi, the way the Zephyr SDK provides them for other
# architectures (DESIGN.md D13).
#
# Zephyr builds picolibc from its module for C, and this port does too. But
# it allows the module only when nothing needs a full C++ library, because
# libc++ has to be built against the same C library it will be linked with.
# So a build with CONFIG_REQUIRES_FULL_LIBCPP uses the toolchain's picolibc
# instead, and that is what this provides. C builds are unchanged: the board
# keeps them on the module.
#
# All come from pinned sources: picolibc from the module checkout west
# already made (with the port's patches applied), and libc++, libc++abi and
# compiler-rt's builtins from the LLVM release matching the compiler. The result is stamped with both, and the
# script does nothing if the stamp matches.
#
# Usage: scripts/build_sysroot.sh [dest]    (default: <west topdir>/wasm-sysroot)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
module="$(cd "$here/.." && pwd)"
topdir="$(cd "$module/.." && pwd)"
dest="${1:-${WASM_SYSROOT:-$topdir/wasm-sysroot}}"

LLVM_VERSION="${LLVM_VERSION:-21}"
LLVM_RELEASE="${LLVM_RELEASE:-21.1.8}"
llvm="${WASM_LLVM_PATH:-/usr/lib/llvm-$LLVM_VERSION}"
picolibc="$topdir/modules/lib/picolibc"

[[ -x "$llvm/bin/clang" ]] || { echo "build_sysroot: no clang at $llvm" >&2; exit 1; }
[[ -d "$picolibc" ]] || { echo "build_sysroot: no picolibc module at $picolibc" >&2; exit 1; }

# What the sysroot is built from. The picolibc tree carries the port's own
# patch, so its diff is part of the stamp as well as its commit.
stamp="picolibc $(git -C "$picolibc" rev-parse HEAD) $(git -C "$picolibc" diff | sha256sum | cut -c1-16)
llvm $LLVM_RELEASE
script $(sha256sum "$0" | cut -c1-16)"
if [[ -f "$dest/STAMP" ]] && [[ "$(cat "$dest/STAMP")" == "$stamp" ]]; then
  echo "build_sysroot: $dest is up to date"
  exit 0
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
rm -rf "$dest"
mkdir -p "$dest"

# What every object in the sysroot is built with: the target, no host C
# library, the float word order clang leaves undefined for wasm32 (D11), and
# one section per function so the link keeps only what is used.
common="--target=wasm32-unknown-unknown -D__FLOAT_WORD_ORDER__=__ORDER_LITTLE_ENDIAN__ -ffunction-sections -fdata-sections"

echo "build_sysroot: picolibc"
cat > "$work/picolibc.cmake" <<EOF
set(CMAKE_SYSTEM_NAME Generic)
set(CMAKE_SYSTEM_PROCESSOR wasm32)
set(CMAKE_C_COMPILER $llvm/bin/clang)
set(CMAKE_ASM_COMPILER $llvm/bin/clang)
set(CMAKE_AR $llvm/bin/llvm-ar)
set(CMAKE_RANLIB $llvm/bin/llvm-ranlib)
set(TARGET_COMPILE_OPTIONS $common -nostdlib)
set(CMAKE_TRY_COMPILE_TARGET_TYPE STATIC_LIBRARY)
EOF
# Configured as Zephyr configures the module for this board
# (modules/lib/picolibc/zephyr/zephyr.cmake): no thread-local storage, errno
# through z_errno_wrap, Zephyr's own malloc, and the board's printf options.
cmake -S "$picolibc" -B "$work/picolibc" -G Ninja \
  -DCMAKE_TOOLCHAIN_FILE="$work/picolibc.cmake" -DCMAKE_INSTALL_PREFIX="$dest" \
  -DCMAKE_BUILD_TYPE=MinSizeRel \
  -D__THREAD_LOCAL_STORAGE=OFF -D__PICOLIBC_ERRNO_FUNCTION=z_errno_wrap \
  -DENABLE_MALLOC=OFF -D__IO_DEFAULT=l -D__IO_LONG_LONG=ON -D__IO_POS_ARGS=ON \
  -D__IO_FLOAT_EXACT=ON -D__IO_SMALL_ULTOA=ON -D__FAST_STRCMP=ON \
  -D__PREFER_SIZE_OVER_SPEED=ON > "$work/picolibc.log"
ninja -C "$work/picolibc" install >> "$work/picolibc.log"

echo "build_sysroot: LLVM $LLVM_RELEASE runtimes source"
src="llvm-project-$LLVM_RELEASE.src"
tarball="${LLVM_TARBALL:-}"
if [[ -z "$tarball" ]]; then
  tarball="$work/llvm.tar.xz"
  curl -fsSL -o "$tarball" \
    "https://github.com/llvm/llvm-project/releases/download/llvmorg-$LLVM_RELEASE/$src.tar.xz"
fi
tar -xJf "$tarball" -C "$work" --wildcards \
  "$src/runtimes/*" "$src/libcxx/*" "$src/libcxxabi/*" "$src/cmake/*" \
  "$src/llvm/cmake/*" "$src/llvm/utils/*" "$src/third-party/*" "$src/libc/*" \
  "$src/compiler-rt/*"

echo "build_sysroot: compiler-rt builtins"
# The routines clang calls for what wasm32 has no instruction for, binary128
# long double above all, which libc++ reaches when it formats one. The port
# carries a few by hand (arch/wasm/core/builtins.c) for C builds, which have
# no sysroot; it is linked first, so its copies win where both have one.
cmake -Wno-dev -S "$work/$src/compiler-rt/lib/builtins" -B "$work/rt" -G Ninja \
  -DCMAKE_C_COMPILER="$llvm/bin/clang" -DCMAKE_AR="$llvm/bin/llvm-ar" \
  -DCMAKE_RANLIB="$llvm/bin/llvm-ranlib" \
  -DCMAKE_C_COMPILER_TARGET=wasm32-unknown-unknown \
  -DCMAKE_ASM_COMPILER_TARGET=wasm32-unknown-unknown \
  -DCMAKE_SYSTEM_NAME=Generic -DCMAKE_TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY \
  -DCMAKE_C_FLAGS="$common -nostdlibinc -isystem $dest/include" \
  -DCMAKE_BUILD_TYPE=MinSizeRel \
  -DCOMPILER_RT_BAREMETAL_BUILD=ON -DCOMPILER_RT_DEFAULT_TARGET_ONLY=ON \
  -DCOMPILER_RT_EXCLUDE_ATOMIC_BUILTIN=ON \
  -DLLVM_CMAKE_DIR="$work/$src/llvm/cmake/modules" > "$work/rt.log"
ninja -C "$work/rt" >> "$work/rt.log"
cp "$work/rt/lib/generic/libclang_rt.builtins-wasm32.a" "$dest/lib/libclang_rt.builtins.a"

echo "build_sysroot: libc++ and libc++abi"
# Against the picolibc just built, after libc++'s own picolibc
# configuration (libcxx/cmake/caches/Armv7M-picolibc.cmake), without
# threads, exceptions, a filesystem or wide characters. Zephyr builds C++
# without exceptions everywhere, and wasm has no threads.
#
# -Wno-c++11-narrowing: libc++ takes newlib's ctype masks as char, and on a
# target where char is signed, as wasm32's is, regex.cpp's table of them
# narrows a negative constant to unsigned short. The bits are the same once
# truncated back to char, which is what they are compared as.
flags="$common -nostdlibinc -isystem $dest/include -fno-exceptions"
cmake -Wno-dev -S "$work/$src/runtimes" -B "$work/cxx" -G Ninja \
  -DCMAKE_C_COMPILER="$llvm/bin/clang" -DCMAKE_CXX_COMPILER="$llvm/bin/clang++" \
  -DCMAKE_AR="$llvm/bin/llvm-ar" -DCMAKE_RANLIB="$llvm/bin/llvm-ranlib" \
  -DCMAKE_C_COMPILER_TARGET=wasm32-unknown-unknown \
  -DCMAKE_CXX_COMPILER_TARGET=wasm32-unknown-unknown \
  -DCMAKE_SYSTEM_NAME=Generic -DCMAKE_TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY \
  -DCMAKE_C_FLAGS="$flags" -DCMAKE_CXX_FLAGS="$flags -Wno-c++11-narrowing" \
  -DCMAKE_BUILD_TYPE=MinSizeRel -DCMAKE_INSTALL_PREFIX="$dest" \
  -DLLVM_ENABLE_RUNTIMES="libcxx;libcxxabi" \
  -DLIBCXX_ENABLE_SHARED=OFF -DLIBCXX_ENABLE_STATIC=ON \
  -DLIBCXX_ENABLE_THREADS=OFF -DLIBCXX_ENABLE_EXCEPTIONS=OFF -DLIBCXX_ENABLE_RTTI=ON \
  -DLIBCXX_ENABLE_FILESYSTEM=OFF -DLIBCXX_ENABLE_RANDOM_DEVICE=OFF \
  -DLIBCXX_ENABLE_MONOTONIC_CLOCK=OFF -DLIBCXX_ENABLE_WIDE_CHARACTERS=OFF \
  -DLIBCXX_INCLUDE_BENCHMARKS=OFF -DLIBCXX_INCLUDE_TESTS=OFF -DLIBCXX_USE_COMPILER_RT=OFF \
  -DLIBCXX_SHARED_OUTPUT_NAME=c++-shared \
  -DLIBCXXABI_BAREMETAL=ON -DLIBCXXABI_ENABLE_SHARED=OFF -DLIBCXXABI_ENABLE_STATIC=ON \
  -DLIBCXXABI_ENABLE_THREADS=OFF -DLIBCXXABI_ENABLE_EXCEPTIONS=OFF \
  -DLIBCXXABI_USE_LLVM_UNWINDER=OFF -DLIBCXXABI_USE_COMPILER_RT=OFF \
  -DLIBCXXABI_INCLUDE_TESTS=OFF -DLIBCXXABI_SHARED_OUTPUT_NAME=c++abi-shared \
  > "$work/cxx.log"
ninja -C "$work/cxx" install-cxx install-cxxabi >> "$work/cxx.log"

echo "$stamp" > "$dest/STAMP"
echo "build_sysroot: $dest ($(du -sh "$dest" | cut -f1))"
