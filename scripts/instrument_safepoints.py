#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Insert a safepoint call at the top of every loop body.

Nothing preempts a running wasm function. A thread that spins without calling
anything cannot be interrupted, which means no time slicing and no way to stop
a runaway guest. Zephyr's answer on real hardware is a timer interrupt; the
equivalent here is to make the check explicit.

The pass works on the text format, where `wasm2wat` prints function bodies in
flat form and every loop begins on its own line:

    loop  ;; label = @1
      call $z_wasm_safepoint      <- inserted
      ...
      br 0

Inserting at the top of the body covers the back-edge and the first iteration
alike, and a call with no operands and no results is valid wherever an
instruction is.

It must run before Asyncify, so the transform sees these calls and can suspend
through them: taking an interrupt here may switch threads.

Functions that implement the check are skipped, since instrumenting them would
recurse.
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

# wasm2wat names a function by index -- (func (;20;) -- unless the module kept
# its name section, which a debug build (CONFIG_DEBUG, -O0) does, and then it
# is (func $z_wasm_safepoint. Either way the token after "func" identifies the
# function, and `call` accepts it as it stands.
FUNC_ID = r"(\$[^\s()]+|\(;\d+;\)|\d+)"
FUNC_RE = re.compile(r"^\s*\(func\s+" + FUNC_ID)
LOOP_RE = re.compile(r"^(\s*)loop(\s|$)")
EXPORT_RE = re.compile(r'^\s*\(export\s+"([^"]+)"\s+\(func\s+' + FUNC_ID + r"\)\)")


def func_id(token: str) -> str:
    """One spelling per function: "(;20;)" and "20" are the same one."""
    return token[2:-2] if token.startswith("(;") else token

# Instrumenting these would call the safepoint from inside the safepoint, or
# from the switch it may trigger. Only exported functions can be identified by
# name here, which is why the safepoint and its helpers are exported.
SKIP_EXPORTS = (
    "z_wasm_safepoint",
    "z_wasm_irq_dispatch",
    "z_wasm_switch",
    # Walks the thread list for the host, between steps. A safepoint in here
    # would dispatch interrupts and reschedule from a call the kernel never
    # made, while the host is holding the Asyncify state.
    "z_wasm_inspect_threads",
)

# Every name above must be exported, or the skip silently protects nothing:
# that is how z_wasm_switch went unprotected, since it was named here but never
# exported. Checked at run time rather than trusted.


def read_exports(lines: list[str]) -> dict[str, str]:
    """Map exported name to function id: an index, or a $name in a debug build.

    The build links through the clang driver, which drops the wasm name
    section, so functions appear only as indices. Exports are the one place a
    name survives, which is why the safepoint has to be exported to be
    callable from here.
    """
    exports: dict[str, str] = {}
    for line in lines:
        m = EXPORT_RE.match(line)
        if m:
            exports[m.group(1)] = func_id(m.group(2))
    return exports


def instrument(lines: list[str], target_idx: str,
               skip_idx: set[str]) -> tuple[list[str], int, int]:
    out: list[str] = []
    current = ""
    inserted = 0
    skipped = 0

    for line in lines:
        m = FUNC_RE.match(line)
        if m:
            current = func_id(m.group(1))
        out.append(line)

        lm = LOOP_RE.match(line)
        if not lm:
            continue
        if current in skip_idx:
            skipped += 1
            continue
        out.append(f"{lm.group(1)}  call {target_idx}\n")
        inserted += 1

    return out, inserted, skipped


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("-i", "--input", required=True, type=Path, help="wat from wasm2wat")
    ap.add_argument("-o", "--output", required=True, type=Path)
    ap.add_argument("--target", default="z_wasm_safepoint",
                    help="name of the function to call")
    args = ap.parse_args()

    lines = args.input.read_text().splitlines(keepends=True)
    exports = read_exports(lines)
    if args.target not in exports:
        sys.stderr.write(
            f"instrument_safepoints: {args.target} is not exported, so there is "
            "no way to name it here. Is CONFIG_WASM_SAFEPOINTS on?\n")
        return 1

    missing = [name for name in SKIP_EXPORTS if name not in exports]
    if missing:
        sys.stderr.write(
            "instrument_safepoints: not exported, so these cannot be skipped "
            f"and would be instrumented: {', '.join(missing)}. Give each an "
            "export_name attribute, or drop it from SKIP_EXPORTS.\n")
        return 1

    skip_idx = {exports[name] for name in SKIP_EXPORTS}
    out, inserted, skipped = instrument(lines, exports[args.target], skip_idx)
    args.output.write_text("".join(out))
    print(f"instrument_safepoints: {inserted} loops instrumented, {skipped} skipped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
