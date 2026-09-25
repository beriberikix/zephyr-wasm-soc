#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Read scripts/apps.json and answer questions about it.

One file names the applications the demo is built from and what each one is
supposed to print. Three things need that list and used to disagree about it:
the staging script, the page's menu, and CI's assertions. They all come
through here now.

Subcommands:
  list        one "<name>\\t<app path>" per line, for the staging script
  manifest    the JSON the page and the site checker read
  score       the count of unmodified upstream samples, which is the measure
              ROADMAP.md sets. Upstream test suites are evidence for the port
              and are deliberately not counted.
  check-uses  compare each build's "uses" and "display" against the .config
              it was built with, in <topdir>/build-site-<name>, so the page
              shows the parts of the board a build has and no others.
"""
import argparse
import json
import os
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
APPS = HERE / "apps.json"


def score(builds: list[dict]) -> int:
    """Upstream samples that run unmodified. See ROADMAP.md.

    Two sources, because upstream only states a run criterion for some of its
    samples. scripts/samples.json holds every sample judged by upstream's own
    criterion -- its console regex, its shell commands, or ztest -- as
    scripts/check_samples.py last found it. Some samples have no such
    criterion upstream: blinky's harness is an LED fixture and button is
    build_only, so upstream CI never runs either. Those count through the
    demo list instead, whose hand-written expectations CI checks on every
    push. A sample counts once, whichever source it comes from.
    """
    return len(counted(builds))


def counted(builds: list[dict]) -> set[str]:
    ours = {b["app"] for b in builds if b.get("upstream") and b.get("kind") == "sample"}
    record = HERE / "samples.json"
    theirs = set()
    if record.exists():
        theirs = {s["path"] for s in json.loads(record.read_text()).get("samples", [])
                  if s.get("status") == "passes"}
    return ours | theirs


USES = {"leds", "buttons", "flash"}


def load(module: str) -> list[dict]:
    builds = json.loads(APPS.read_text())["builds"]
    for b in builds:
        b["app"] = b["app"].replace("{module}", module)
        # The page shows both, and a build without them is the page
        # drifting back to one style per entry.
        for key in ("title", "hint"):
            if not b.get(key):
                sys.exit(f"apps.json: {b['name']} has no {key}")
        unknown = set(b.get("uses", [])) - USES
        if unknown:
            sys.exit(f"apps.json: {b['name']} uses unknown {sorted(unknown)}")
    return builds


def check_uses(builds: list[dict], topdir: pathlib.Path) -> list[str]:
    """What the page shows against what the build has.

    Display and flash must match both ways: a canvas or an Erase button that
    does nothing is as wrong as one that is missing. GPIO only one way,
    because input drivers pull it in for builds with nothing to show on the
    LED strip. The LEDs and the buttons are shown separately: blinky has no
    use for the buttons.
    """
    problems = []
    for b in builds:
        config = topdir / f"build-site-{b['name']}" / "zephyr" / ".config"
        if not config.exists():
            problems.append(f"{b['name']}: no {config}")
            continue
        on = set()
        for line in config.read_text().splitlines():
            for sym, use in (("GPIO", "gpio"), ("FLASH", "flash"), ("DISPLAY", "display")):
                if line == f"CONFIG_{sym}=y":
                    on.add(use)
        shown = set(b.get("uses", [])) | ({"display"} if b.get("display") else set())
        for use in ("flash", "display"):
            if (use in on) != (use in shown):
                problems.append(f"{b['name']}: CONFIG_{use.upper()} is "
                                f"{'set' if use in on else 'unset'} but the page "
                                f"{'does not show' if use in on else 'shows'} it")
        for part in ("leds", "buttons"):
            if part in shown and "gpio" not in on:
                problems.append(f"{b['name']}: the page shows the {part} "
                                "but CONFIG_GPIO is unset")
    return problems


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--module", default=str(HERE.parent),
                    help="this repository, substituted for {module} in an app path")
    ap.add_argument("--topdir", default=str(HERE.parent.parent),
                    help="where the build-site-<name> directories are, for check-uses")
    ap.add_argument("command", choices=("list", "manifest", "score", "check-uses"))
    args = ap.parse_args()

    builds = load(args.module)

    if args.command == "check-uses":
        problems = check_uses(builds, pathlib.Path(args.topdir))
        for p in problems:
            print(f"apps.json: {p}", file=sys.stderr)
        return 1 if problems else 0

    if args.command == "list":
        # A third column carries any build arguments, space-separated. They
        # are only ever an upstream entry's own extra_configs: the LVGL demos
        # app picks its demo that way.
        for b in builds:
            print(f"{b['name']}\t{b['app']}\t{' '.join(b.get('args', []))}")
        return 0

    if args.command == "score":
        print(score(builds))
        return 0

    # The manifest is the apps list with the module path resolved and the
    # published location of each module filled in. Deliberately the same
    # shape, so that adding a field to apps.json makes it available to the
    # page without a second edit here.
    out = {
        "_comment": "Generated by scripts/stage_site.sh from scripts/apps.json. Do not edit.",
        # What this site was built from, which the page shows at its foot so
        # that a report about it can say which build it was about.
        # stage_site.sh passes it in; a manifest made any other way has none.
        "site": {
            "commit": os.environ.get("SITE_COMMIT", ""),
            "zephyr": os.environ.get("SITE_ZEPHYR", ""),
            "built": os.environ.get("SITE_BUILT", ""),
        },
        "score": score(builds),
        "builds": [dict(b, path=f"m/{b['name']}.wasm") for b in builds],
    }
    json.dump(out, sys.stdout, indent=2)
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
