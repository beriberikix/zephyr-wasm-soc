#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Try the fixes this port proposes to Zephyr, without keeping them.
#
# upstream/zephyr/ holds changes meant for Zephyr itself: bugs this port
# found that are bugs on every target. They are not in patches/, because the
# score counts samples that run on Zephyr as it is, so a sample that only
# runs with them does not count until Zephyr takes them. This applies them to
# the workspace's Zephyr tree on top of the port's own patches, runs the
# samples and kernel suites they are meant to fix, and takes them back out
# whatever happens, leaving the tree as apply_patches.sh left it.
#
# Usage: scripts/try_upstream.sh
#
# The samples' results go to a scratch copy of the record, printed at the
# end, so scripts/samples.json keeps describing unmodified Zephyr.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
module="$(cd "$here/.." && pwd)"
zephyr="${ZEPHYR_BASE:-$(cd "$module/../zephyr" && pwd)}"
series=("$module"/upstream/zephyr/*.patch)

applied=()
revert() {
  for ((i = ${#applied[@]} - 1; i >= 0; i--)); do
    git -C "$zephyr" apply -R "${applied[i]}"
  done
  echo "reverted ${#applied[@]} upstream patch(es); $zephyr is as it was"
}
trap revert EXIT

for p in "${series[@]}"; do
  git -C "$zephyr" apply "$p"
  applied+=("$p")
  echo "applied $(basename "$p")"
done

record="$(mktemp -d)/samples.json"
cp "$module/scripts/samples.json" "$record"
# The entries recorded as failing on D8b are the ones these patches are for.
entries="$(python3 - "$record" <<'PY'
import json, sys
print(",".join(s["entry"] for s in json.load(open(sys.argv[1]))["samples"]
               if s.get("cause") == "d8b"))
PY
)"
status=0
python3 "$here/check_samples.py" --only "$entries" --update --record "$record" || status=1
python3 "$here/check_kernel.py" --only mutex/mutex_api,pending || status=1
echo "scratch record: $record"
exit "$status"
