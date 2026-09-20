#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Serve the staged demo for local viewing.
#
# Serves _site, the same directory CI publishes, so what is seen locally is
# what ships. Bound to the loopback address: nothing here should be reachable
# from anywhere else.
set -euo pipefail
port="${1:-8777}"
root="$(cd "$(dirname "$0")/../.." && pwd)/_site"
if [ ! -d "$root" ]; then
  echo "no _site yet; run scripts/stage_site.sh first" >&2
  exit 1
fi
echo "serving $root on http://127.0.0.1:$port"
echo "page: http://127.0.0.1:$port/"
exec python3 -m http.server "$port" --bind 127.0.0.1 --directory "$root"
