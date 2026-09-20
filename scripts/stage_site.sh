#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Assemble the browser demo into _site/.
#
# The same script runs locally and in CI, so what is published is what was
# tested. The page fetches ./m/<name>.wasm, which is why the modules are
# copied in under short names rather than left in their build directories.
#
# The list of applications lives in scripts/apps.json, not here. This script
# builds what that file names and writes _site/manifest.json, which the page
# reads its menu from and scripts/check_site.mjs reads its expectations from.
# One entry in one file is the whole of adding a build.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
module="$(cd "$here/.." && pwd)"
topdir="$(cd "$module/.." && pwd)"
site="${SITE_DIR:-$topdir/_site}"

rm -rf "$site"
mkdir -p "$site/m"
cp "$module/host/web/index.html" "$module/host/web/worker.js" "$module/host/core.mjs" "$site/"

cd "$topdir"

# name and application path for each build, in the order the page lists them.
while IFS=$'\t' read -r name app; do
  build="build-site-$name"
  if [ ! -f "$build/zephyr/zephyr.wasm" ]; then
    echo "building $name from $app"
    # Quiet on success, but show everything on failure: a build log that is
    # thrown away is no use when the failure is on someone else's machine.
    if ! "$module/scripts/build.sh" "$build" "$app" > "$build.log" 2>&1; then
      echo "--- build of $name failed ---"
      cat "$build.log"
      exit 1
    fi
  fi
  cp "$build/zephyr/zephyr.wasm" "$site/m/$name.wasm"
  printf "  %-6s %s\n" "$name" "$(du -h "$site/m/$name.wasm" | cut -f1)"
done < <(python3 "$here/apps.py" --module "$module" list)

python3 "$here/apps.py" --module "$module" manifest > "$site/manifest.json"
echo "staged $site"
