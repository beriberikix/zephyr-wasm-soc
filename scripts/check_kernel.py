#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Build and run Zephyr's own kernel test suites on wasm_node.

The kernel is what everything else in this port stands on, and for a long
time the evidence for it was one suite. This builds and runs the list in
scripts/kernel_tests.json and compares each result against the status
recorded there, so the evidence stays true rather than being taken once.

A suite that does better than its recorded status is reported too. That is
the interesting direction and it should be written down when it happens.

Usage:
  scripts/check_kernel.py [--only name,name] [--jobs N] [--update]

--update rewrites the recorded statuses from this run, for when a fix moves
several at once. Read the diff before committing it.
"""
import argparse
import concurrent.futures
import json
import pathlib
import re
import shutil
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
MODULE = HERE.parent
TOP = MODULE.parent
LIST = HERE / "kernel_tests.json"

PASS_RE = re.compile(r"^ PASS", re.M)
FAIL_RE = re.compile(r"^ FAIL", re.M)


def run_one(entry: dict, keep: bool) -> dict:
    """Build and run one suite; return what happened, in the recorded shape."""
    name = entry["path"]
    build = TOP / f"build-kernel-{name.replace('/', '_')}"
    app = f"zephyr/tests/kernel/{name}"
    result = {"path": name}

    built = subprocess.run(
        [str(MODULE / "scripts" / "build.sh"), str(build), app],
        cwd=TOP, capture_output=True, text=True)
    if built.returncode != 0:
        err = re.search(r"error: (.*)", built.stdout + built.stderr)
        result["status"] = "build-fails"
        result["note"] = (err.group(1) if err else built.stderr.strip().split("\n")[-1])[:160]
        return result

    ran = subprocess.run(
        ["node", str(MODULE / "host" / "run.mjs"),
         "--max-time", str(entry.get("max_time_ms", 120000)),
         str(build / "zephyr" / "zephyr.wasm")],
        cwd=TOP, capture_output=True, text=True, timeout=900)
    out = ran.stdout + ran.stderr
    if not keep:
        shutil.rmtree(build, ignore_errors=True)

    passed, failed = len(PASS_RE.findall(out)), len(FAIL_RE.findall(out))
    result["passes"] = passed
    if "PROJECT EXECUTION SUCCESSFUL" in out:
        result["status"] = "passes"
    elif "PROJECT EXECUTION FAILED" in out:
        result["status"] = "fails"
        result["failures"] = failed
    else:
        result["status"] = "does-not-finish"
        # The boot banner is also *** wrapped ***, so look for what went
        # wrong rather than for the first thing that matches the shape.
        hint = re.search(r"(RuntimeError: [^\n]*|\*\*\* (?:fatal|gave up)[^\n]*)", out)
        result["note"] = (hint.group(1) if hint else f"exit {ran.returncode}")[:160]
    return result


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--only", help="comma-separated suite paths")
    ap.add_argument("--jobs", type=int, default=1,
                    help="suites to build at once. One by default, because "
                         "building several at once intermittently fails on a "
                         "generated header that has not been written yet, and "
                         "a regression harness that reports failures it caused "
                         "itself is worse than a slow one. Higher is faster and "
                         "occasionally lies.")
    ap.add_argument("--update", action="store_true",
                    help="rewrite the recorded statuses from this run")
    ap.add_argument("--keep-builds", action="store_true")
    args = ap.parse_args()

    doc = json.loads(LIST.read_text())
    suites = doc["suites"]
    if args.only:
        want = set(args.only.split(","))
        suites = [s for s in suites if s["path"] in want]

    results = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.jobs) as pool:
        futures = {pool.submit(run_one, s, args.keep_builds): s for s in suites}
        for fut in concurrent.futures.as_completed(futures):
            r = fut.result()
            results[r["path"]] = r

    worse, better = [], []
    for s in suites:
        got = results[s["path"]]
        line = f"  {got['status']:<16} {s['path']:<30}"
        if got["status"] == "passes":
            line += f"{got.get('passes', 0)} passed"
        elif got["status"] == "fails":
            line += f"{got.get('passes', 0)} passed, {got.get('failures', 0)} failed"
        else:
            line += got.get("note", "")
        if got["status"] != s["status"]:
            # Worst to best. A suite that will not link is worse than one
            # that runs and then traps: the second at least got somewhere.
            rank = ["build-fails", "does-not-finish", "fails", "passes"]
            if rank.index(got["status"]) > rank.index(s["status"]):
                better.append(s["path"])
                line += f"   (better than recorded: {s['status']})"
            else:
                worse.append(s["path"])
                line += f"   <-- RECORDED AS {s['status']}"
        print(line)

    if args.update:
        for s in suites:
            got = results[s["path"]]
            s["status"] = got["status"]
            for key in ("passes", "failures", "note"):
                s.pop(key, None)
                if key in got:
                    s[key] = got[key]
        LIST.write_text(json.dumps(doc, indent=2) + "\n")
        print(f"updated {LIST}")
        return 0

    if worse:
        print(f"\n{len(worse)} suite(s) did worse than recorded: {', '.join(worse)}")
        return 1
    if better:
        print(f"\n{len(better)} suite(s) did better than recorded: {', '.join(better)}")
        print("Record it: scripts/check_kernel.py --update")
    else:
        print(f"\n{len(suites)} suite(s) match what is recorded")
    return 0


if __name__ == "__main__":
    sys.exit(main())
