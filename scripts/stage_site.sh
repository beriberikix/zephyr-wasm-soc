#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Assemble the browser demo into _site/.
#
# The same script runs locally and in CI, so what is published is what was
# tested. The page fetches ./m/<name>.wasm, which is why the modules are
# copied in under short names rather than left in their build directories.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
module="$(cd "$here/.." && pwd)"
topdir="$(cd "$module/.." && pwd)"
site="${SITE_DIR:-$topdir/_site}"

# name -> application, in the order the page lists them
apps=(
  "hello:zephyr/samples/hello_world"
  "sync:zephyr/samples/synchronization"
  "sem:zephyr/tests/kernel/semaphore/semaphore"
  "slice:$module/tests/timeslice"
  "shell:zephyr/samples/subsys/shell/shell_module"
)

rm -rf "$site"
mkdir -p "$site/m"
cp "$module/host/web/index.html" "$module/host/web/worker.js" "$module/host/core.mjs" "$site/"

cd "$topdir"
for entry in "${apps[@]}"; do
  name="${entry%%:*}"
  app="${entry#*:}"
  build="build-site-$name"
  if [ ! -f "$build/zephyr/zephyr.wasm" ]; then
    echo "building $name from $app"
    "$module/scripts/build.sh" "$build" "$app" > /dev/null
  fi
  cp "$build/zephyr/zephyr.wasm" "$site/m/$name.wasm"
  printf "  %-6s %s\n" "$name" "$(du -h "$site/m/$name.wasm" | cut -f1)"
done

echo "staged $site"
