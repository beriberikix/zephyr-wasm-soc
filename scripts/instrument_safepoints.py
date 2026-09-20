#!/usr/bin/env python3
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

FUNC_RE = re.compile(r"^\s*\(func\s+\(;(\d+);\)")
LOOP_RE = re.compile(r"^(\s*)loop(\s|$)")
EXPORT_RE = re.compile(r'^\s*\(export\s+"([^"]+)"\s+\(func\s+(\d+)\)\)')

# Instrumenting these would call the safepoint from inside the safepoint, or
# from the switch it may trigger. Only exported functions can be identified by
# name here, which is why the safepoint and its helpers are exported.
SKIP_EXPORTS = (
    "z_wasm_safepoint",
    "z_wasm_irq_dispatch",
    "z_wasm_switch",
)


def read_exports(lines: list[str]) -> dict[str, int]:
    """Map exported name to function index.

    The build links through the clang driver, which drops the wasm name
    section, so functions appear only as indices. Exports are the one place a
    name survives, which is why the safepoint has to be exported to be
    callable from here.
    """
    exports: dict[str, int] = {}
    for line in lines:
        m = EXPORT_RE.match(line)
        if m:
            exports[m.group(1)] = int(m.group(2))
    return exports


def instrument(lines: list[str], target_idx: int,
               skip_idx: set[int]) -> tuple[list[str], int, int]:
    out: list[str] = []
    current = -1
    inserted = 0
    skipped = 0

    for line in lines:
        m = FUNC_RE.match(line)
        if m:
            current = int(m.group(1))
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

    skip_idx = {exports[name] for name in SKIP_EXPORTS if name in exports}
    out, inserted, skipped = instrument(lines, exports[args.target], skip_idx)
    args.output.write_text("".join(out))
    print(f"instrument_safepoints: {inserted} loops instrumented, {skipped} skipped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
