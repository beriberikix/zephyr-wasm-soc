#!/usr/bin/env bash
# Serve the workspace so a browser can reach both the harness and the builds.
#
# One server covers zephyr-wasm/host/web/ and the build-*/ output directories,
# so the page can fetch a module by an absolute path. Bound to the loopback
# address: nothing here should be reachable from anywhere else.
set -euo pipefail
port="${1:-8777}"
root="$(cd "$(dirname "$0")/../.." && pwd)"
echo "serving $root on http://127.0.0.1:$port"
echo "page: http://127.0.0.1:$port/zephyr-wasm/host/web/index.html"
exec python3 -m http.server "$port" --bind 127.0.0.1 --directory "$root"
