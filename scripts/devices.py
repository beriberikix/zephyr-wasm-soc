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
which controls the page shows for the site's builds. For a build the page
knows nothing else about, uses() below is the best guess, and it is the
same rule check-uses holds the site's builds to. See DESIGN.md D16, D17.

Every build carries what this works out in its zephyr.wasm, in a custom
section (scripts/describe_board.py), so that a module dropped onto the page
describes itself, and staging reads it back from there (wasmsection.py).
"""
import pathlib
import pickle
import re
import sys

ORD = re.compile(r"__device_dts_ord_(\d+)")
GPIO_ACTIVE_LOW = 1
SECTION = "zephyr.board"


def _edtlib(src: pathlib.Path) -> None:
    """edt.pickle holds edtlib objects; unpickling needs the edtlib of the
    Zephyr tree that made it, from <zephyr>/scripts/dts/python-devicetree/src."""
    if str(src) not in sys.path:
        sys.path.insert(0, str(src))


def edtlib_src(zephyr_base: pathlib.Path) -> pathlib.Path:
    return zephyr_base / "scripts" / "dts" / "python-devicetree" / "src"


def _gpio(node) -> dict:
    spec = node.props["gpios"].val[0]
    return {"pin": spec.data["pin"], "activeLow": bool(spec.data["flags"] & GPIO_ACTIVE_LOW)}


def _label(node) -> str:
    return node.props["label"].val if "label" in node.props else node.name


def describe(edt_file: pathlib.Path, map_file: pathlib.Path, zephyr_base: pathlib.Path) -> dict:
    """The board one build has: its LEDs, buttons and display as the
    devicetree wires them, and every device the image was linked with."""
    _edtlib(edtlib_src(zephyr_base))
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


def config_symbols(config_text: str) -> set[str]:
    """The symbols a .config sets to y, without the CONFIG_ prefix."""
    return {m.group(1) for m in re.finditer(r"^CONFIG_(\w+)=y$", config_text, re.M)}


def uses(board: dict, on: set[str]) -> list[str]:
    """What the page would show for a build, from what it was linked with
    and its configuration. A build reads what is typed if it has a shell,
    takes UART interrupts itself (echo_bot) or reads the console subsystem;
    Bluetooth's H4 driver takes UART interrupts too, on the HCI UART, and
    that is not the console's. LEDs and buttons cannot be told apart from
    here: both come with the GPIO controller."""
    compats = {d["compat"] for d in board["devices"]}
    out = []
    if "zephyr,gpio-emul" in compats:
        out += ["leds", "buttons"]
    if "zephyr,sim-flash" in compats:
        out.append("flash")
    if "SHELL" in on or "CONSOLE_SUBSYS" in on or (
            "UART_INTERRUPT_DRIVEN" in on and "BT_UART" not in on):
        out.append("terminal")
    if "bosch,bmi160" in compats and "SENSOR_WASM_BRIDGE" in on:
        out.append("accel")
    return out


def summary(board: dict, on: set[str]) -> dict:
    """What the page needs to run a build it has no entry for."""
    compats = {d["compat"] for d in board["devices"]}
    return {
        "uses": uses(board, on),
        "display": "wasm,host-display" in compats,
        "network": "wasm,host-ethernet" in compats,
        "radio": "zephyr,bt-hci-uart" in compats,
    }
