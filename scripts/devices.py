# SPDX-License-Identifier: Apache-2.0
"""What a build's board is, from its own devicetree, for the page.

Two sources, because neither alone says it. The devicetree (edt.pickle in the
build directory) names every part of the board and how it is wired, but it
is nearly the same for every build: only a snippet adds a node (the HCI UART,
the Ethernet). The link map names the device objects the image was actually
linked with, __device_dts_ord_<N>, which is what the build has: blinky has
the GPIO controller, accel_polling the I2C bus and its sensors, an HTTP
client the Ethernet. edtlib's dep_ordinal joins the two.

Which parts a sample *uses* is in neither -- blinky drives LED 0 through a
gpio_dt_spec, and no LED device exists -- so apps.json's "uses" still says
which controls the page shows. See DESIGN.md D16.
"""
import pathlib
import pickle
import re
import sys

ORD = re.compile(r"__device_dts_ord_(\d+)")
GPIO_ACTIVE_LOW = 1


def _edtlib(topdir: pathlib.Path) -> None:
    """edt.pickle holds edtlib objects; unpickling needs the edtlib of the
    Zephyr tree that made it."""
    src = topdir / "zephyr" / "scripts" / "dts" / "python-devicetree" / "src"
    if str(src) not in sys.path:
        sys.path.insert(0, str(src))


def _gpio(node) -> dict:
    spec = node.props["gpios"].val[0]
    return {"pin": spec.data["pin"], "activeLow": bool(spec.data["flags"] & GPIO_ACTIVE_LOW)}


def _label(node) -> str:
    return node.props["label"].val if "label" in node.props else node.name


def describe(build_dir: pathlib.Path, topdir: pathlib.Path) -> dict | None:
    """The board one build has, or None when it has not been built here."""
    edt_file = build_dir / "zephyr" / "edt.pickle"
    map_file = build_dir / "zephyr" / "zephyr.map"
    if not edt_file.exists() or not map_file.exists():
        return None
    _edtlib(topdir)
    with edt_file.open("rb") as f:
        edt = pickle.load(f)
    linked = {int(n) for n in ORD.findall(map_file.read_text(errors="replace"))}

    roles = {}
    for role, node in edt.chosen_nodes.items():
        roles.setdefault(node.path, []).append(role.removeprefix("zephyr,"))

    def part(node, **extra):
        return {"label": _label(node), "alias": (node.aliases or [None])[0],
                "node": node.name, **_gpio(node), **extra}

    out = {"leds": [], "buttons": [], "display": None, "devices": []}
    for node in edt.nodes:
        if node.status != "okay":
            continue
        compat = node.compats[0] if node.compats else None
        if compat == "gpio-leds":
            out["leds"] += [part(c) for c in node.children.values() if c.status == "okay"]
        elif compat == "gpio-keys":
            out["buttons"] += [part(c, code=c.props["zephyr,code"].val
                                    if "zephyr,code" in c.props else None)
                               for c in node.children.values() if c.status == "okay"]
        elif compat == "wasm,host-display":
            out["display"] = {"width": node.props["width"].val, "height": node.props["height"].val}
        if node.dep_ordinal not in linked:
            continue
        bus = node.parent if node.parent and node.parent.path not in ("/", "/soc") else None
        out["devices"].append({
            "name": node.name,
            "path": node.path,
            "compat": compat,
            "labels": list(node.labels),
            "aliases": list(node.aliases),
            "on": bus.name if bus else None,
            "roles": roles.get(node.path, []),
        })
    return out
