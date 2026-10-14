#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Write a build's description into its zephyr.wasm, as a custom section.

The last post-link step (cmake/postlink_wasm.cmake). A module dropped onto
the page has nothing beside it to say what it is: which controls it wants,
whether it has a network or a radio, what hardware it was built with. So
every build carries that itself, in a section called "zephyr.board" that
runtimes skip: the board as devices.py describes it, what the page would
show for it, the application's name and Zephyr's version, and the
devicetree source. Staging and check-uses read the same section back.
See DESIGN.md D17.
"""
import argparse
import json
import os
import pathlib

import devices
import wasmsection


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--wasm", required=True, type=pathlib.Path)
    ap.add_argument("--edt", required=True, type=pathlib.Path)
    ap.add_argument("--map", required=True, type=pathlib.Path)
    ap.add_argument("--config", required=True, type=pathlib.Path)
    ap.add_argument("--dts", required=True, type=pathlib.Path)
    ap.add_argument("--zephyr-base", required=True, type=pathlib.Path)
    ap.add_argument("--app", required=True, help="the application's source directory")
    ap.add_argument("--topdir", default="", help="the west workspace, if there is one")
    ap.add_argument("--version", default="")
    args = ap.parse_args()

    board = devices.describe(args.edt, args.map, args.zephyr_base)
    on = devices.config_symbols(args.config.read_text())
    # The application by its place in the workspace -- zephyr/samples/... --
    # and never by a path on the machine that built it, which would go
    # wherever the module is shared.
    app = os.path.realpath(args.app)
    top = os.path.realpath(args.topdir) if args.topdir else ""
    name = (os.path.relpath(app, top) if top and app.startswith(top + os.sep)
            else os.path.basename(app))
    desc = {
        "app": name.replace(os.sep, "/"),
        "zephyr": args.version,
        **devices.summary(board, on),
        "devicetree": board,
        "dts": args.dts.read_text(),
    }
    payload = json.dumps(desc, sort_keys=True, separators=(",", ":")).encode()
    wasmsection.replace(args.wasm, devices.SECTION, payload)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
