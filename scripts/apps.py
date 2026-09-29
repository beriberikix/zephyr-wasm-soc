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
import re
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
    push. A sample counts once, whichever source it comes from. A
    two-board entry counts each board's application: the pair's checks are
    what judges both.
    """
    return len(counted(builds))


def counted(builds: list[dict]) -> set[str]:
    ours = {u["app"] for b in builds if b.get("upstream") and b.get("kind") == "sample"
            for u in units(b)}
    record = HERE / "samples.json"
    theirs = set()
    if record.exists():
        theirs = {s["path"] for s in json.loads(record.read_text()).get("samples", [])
                  if s.get("status") == "passes"}
    return ours | theirs


USES = {"leds", "buttons", "flash", "terminal", "accel"}
# The Kconfig symbol each use is checked against, where it is not its own name.
SYMBOL = {"terminal": "SHELL", "accel": "SENSOR_WASM_BRIDGE"}


# What a pair's board may be built with, beyond upstream's own files. The
# score counts samples that run unmodified; for a pair that means unmodified
# source, with build arguments limited to putting the two boards on one
# network: turning the link on, addresses, ports, and switching off an IP
# version the other side does not speak. Anything else, a buffer size or a
# feature, is a change to the sample and is refused here. ROADMAP's "The
# measure" states the rule.
PAIR_ARG = re.compile(
    r"^-D(?:SNIPPET=wasm-ethernet"
    r"|CONFIG_NET_CONFIG_(?:MY|PEER)_IPV[46]_ADDR=.*"
    r"|CONFIG_NET_CONFIG_NEED_IPV[46]=n"
    r"|CONFIG_NET_IPV[46]=n"
    r"|CONFIG_NET_SAMPLE_[A-Z0-9_]*(?:_PEER|_PORT|_ADDR|_ADDRESS|_RESOURCE_PATH)=.*)$")


def units(b: dict) -> list[dict]:
    """What gets built for an entry: itself, or each of its boards.

    A two-board entry has no app of its own. Its boards are built as
    <name>-0 and <name>-1, and each carries what a single build would:
    app, args, uses, expect.
    """
    if "boards" not in b:
        return [b]
    return [dict(board, name=f"{b['name']}-{i}") for i, board in enumerate(b["boards"])]


def load(module: str) -> list[dict]:
    builds = json.loads(APPS.read_text())["builds"]
    for b in builds:
        if "boards" in b:
            # Two boards joined by the wasm-ethernet link: the page runs
            # them side by side, run.mjs --peer runs them in CI.
            boards = b["boards"]
            if len(boards) != 2 or not all(x.get("app") and x.get("label") for x in boards):
                sys.exit(f"apps.json: {b['name']} needs two boards, each with an app and a label")
            if "app" in b:
                sys.exit(f"apps.json: {b['name']} has boards, so it has no app of its own")
            overridden = False
            for x in boards:
                for arg in x.get("args", []):
                    if not PAIR_ARG.match(arg):
                        sys.exit(f"apps.json: {b['name']}: {x['label']} is built with {arg}, and a "
                                 "pair's boards may only be given the link, addresses, ports and "
                                 "IP versions (see PAIR_ARG in scripts/apps.py)")
                    overridden |= arg.startswith("-DCONFIG_")
            # Anything set at build time is said in words on the page.
            if overridden and not b.get("overrides"):
                sys.exit(f"apps.json: {b['name']} overrides its boards' configuration, "
                         "so it needs an overrides sentence saying how")
        if b.get("uplink"):
            # A board on a real network through a relay (host/uplink.mjs).
            # The relay is its peer, so it is built as upstream ships it with
            # the link turned on, and nothing else: no address is set, since
            # the relay's DHCP gives it one.
            if "boards" in b:
                sys.exit(f"apps.json: {b['name']}: an uplink is for one board, not a pair")
            extra = [a for a in b.get("args", []) if a != "-DSNIPPET=wasm-ethernet"]
            if extra or "-DSNIPPET=wasm-ethernet" not in b.get("args", []):
                sys.exit(f"apps.json: {b['name']} has an uplink, so it is built with "
                         "-DSNIPPET=wasm-ethernet and nothing else")
        if b.get("lan"):
            # A board on the host's own network (host/lan.mjs), which plays
            # the Linux host the samples expect at 192.0.2.2. Its args are
            # what a pair's board may have, since the LAN is its peer.
            if "boards" in b:
                sys.exit(f"apps.json: {b['name']}: the LAN is for one board, not a pair")
            if "-DSNIPPET=wasm-ethernet" not in b.get("args", []):
                sys.exit(f"apps.json: {b['name']} is on the LAN, so it needs -DSNIPPET=wasm-ethernet")
            for arg in b.get("args", []):
                if not PAIR_ARG.match(arg):
                    sys.exit(f"apps.json: {b['name']} is built with {arg}, and a board on the LAN "
                             "may only be given the link, addresses, ports and IP versions "
                             "(see PAIR_ARG in scripts/apps.py)")
            if any(a.startswith("-DCONFIG_") for a in b.get("args", [])) and not b.get("overrides"):
                sys.exit(f"apps.json: {b['name']} overrides its configuration, "
                         "so it needs an overrides sentence saying how")
            lan = b["lan"]
            if lan is not True and not (
                    isinstance(lan, dict) and set(lan) <= {"dial", "ping"} and
                    all(isinstance(d.get("at_ms"), int) and isinstance(d.get("port"), int) and
                        str(d.get("path", "/")).startswith("/") and set(d) <= {"at_ms", "port", "path"}
                        for d in lan.get("dial", [])) and
                    all(isinstance(ms, int) for ms in lan.get("ping", []))):
                sys.exit(f"apps.json: {b['name']}: lan is true, or has dial: "
                         f"[{{\"at_ms\", \"port\", \"path\"}}] and ping: [ms]")
        if b.get("lan_expect") and not b.get("lan"):
            sys.exit(f"apps.json: {b['name']} has lan_expect but is not on the LAN")
        for u in units(b):
            u["app"] = u["app"].replace("{module}", module)
        if "boards" in b:
            b["boards"] = [dict(x, app=x["app"].replace("{module}", module)) for x in b["boards"]]
        # The page shows both, and a build without them is the page
        # drifting back to one style per entry.
        for key in ("title", "hint"):
            if not b.get(key):
                sys.exit(f"apps.json: {b['name']} has no {key}")
        lesson = b.get("lesson", [])
        if not isinstance(lesson, list) or not all(isinstance(x, str) and x for x in lesson):
            sys.exit(f"apps.json: {b['name']} has a lesson that is not a list of steps")
        for u in units(b):
            unknown = set(u.get("uses", [])) - USES
            if unknown:
                sys.exit(f"apps.json: {u['name']} uses unknown {sorted(unknown)}")
    return builds


def check_uses(builds: list[dict], topdir: pathlib.Path) -> list[str]:
    """What the page shows against what the build has.

    Display, flash, the terminal and the tilt control must match both ways: a
    canvas or an Erase button that does nothing is as wrong as one that is
    missing. GPIO only one way,
    because input drivers pull it in for builds with nothing to show on the
    LED strip. The LEDs and the buttons are shown separately: blinky has no
    use for the buttons.
    """
    problems = []
    for b in (u for entry in builds for u in units(entry)):
        config = topdir / f"build-site-{b['name']}" / "zephyr" / ".config"
        if not config.exists():
            problems.append(f"{b['name']}: no {config}")
            continue
        on = set()
        for line in config.read_text().splitlines():
            for sym, use in (("GPIO", "gpio"), ("FLASH", "flash"), ("DISPLAY", "display"),
                             ("SHELL", "terminal"), ("SENSOR_WASM_BRIDGE", "accel")):
                if line == f"CONFIG_{sym}=y":
                    on.add(use)
        shown = set(b.get("uses", [])) | ({"display"} if b.get("display") else set())
        for use in ("flash", "display", "terminal", "accel"):
            if (use in on) != (use in shown):
                problems.append(f"{b['name']}: CONFIG_{SYMBOL.get(use, use.upper())} is "
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
        for b in (u for entry in builds for u in units(entry)):
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
        "builds": [dict(b, boards=[dict(u, path=f"m/{u['name']}.wasm") for u in units(b)])
                   if "boards" in b else dict(b, path=f"m/{b['name']}.wasm")
                   for b in builds],
    }
    json.dump(out, sys.stdout, indent=2)
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
