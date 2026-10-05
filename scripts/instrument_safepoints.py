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

A function that makes no calls may keep its stack frame below
`__stack_pointer` without moving it: LLVM reads the global, subtracts the frame
and uses that, because nothing it calls could need the space. A safepoint makes
it a caller after the fact, and an interrupt taken there would put its own
frames on top of that one. So in such a function each safepoint call is wrapped
in a move of the stack pointer past the frame and back (DESIGN.md D8e).
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
# wasm-ld makes __stack_pointer the first global, and a debug build names it.
SP_GLOBALS = ("0", "$__stack_pointer")
FRAME_CONST_RE = re.compile(r"^\s*i32\.const\s+(\d+)\s*$")


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


def unpublished_frames(lines: list[str]) -> dict[str, int]:
    """Functions that read the stack pointer and never write it, and their frames.

    The frame is the constant LLVM subtracts from the pointer it read. A
    function that reads it and never writes it some other way is reported
    rather than guessed at.
    """
    frames: dict[str, int] = {}
    current, reads, writes, frame = "", False, False, None

    def close():
        if current and reads and not writes:
            if frame is None:
                raise SystemExit(f"instrument_safepoints: function {current} reads the "
                                 "stack pointer without writing it, and not in the "
                                 "pattern recognised here; see DESIGN.md D8e")
            frames[current] = frame

    for i, line in enumerate(lines):
        m = FUNC_RE.match(line)
        if m:
            close()
            current, reads, writes, frame = func_id(m.group(1)), False, False, None
            continue
        t = line.strip()
        if t in (f"global.get {g}" for g in SP_GLOBALS):
            reads = True
            if frame is None and i + 2 < len(lines):
                c = FRAME_CONST_RE.match(lines[i + 1])
                if c and lines[i + 2].strip() == "i32.sub":
                    frame = int(c.group(1))
        elif t in (f"global.set {g}" for g in SP_GLOBALS):
            writes = True
    close()
    return frames


def instrument(lines: list[str], target_idx: str,
               skip_idx: set[str]) -> tuple[list[str], int, int]:
    out: list[str] = []
    current = ""
    inserted = 0
    skipped = 0
    frames = unpublished_frames(lines)
    sp = next((g for g in SP_GLOBALS if any(l.strip() == f"global.get {g}" for l in lines)),
              SP_GLOBALS[0])

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
        pad = lm.group(1) + "  "
        frame = frames.get(current)
        if frame:
            # Publish the frame for the length of the call, so what the
            # safepoint runs is stacked below it, then give it back.
            frame = (frame + 15) & ~15
            out.extend(f"{pad}{ins}\n" for ins in (
                f"global.get {sp}", f"i32.const {frame}", "i32.sub", f"global.set {sp}"))
            out.append(f"{pad}call {target_idx}\n")
            out.extend(f"{pad}{ins}\n" for ins in (
                f"global.get {sp}", f"i32.const {frame}", "i32.add", f"global.set {sp}"))
        else:
            out.append(f"{pad}call {target_idx}\n")
        inserted += 1

    return out, inserted, skipped


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("-i", "--input", required=True, type=Path, help="wat from wasm2wat")
    ap.add_argument("-o", "--output", required=True, type=Path)
    ap.add_argument("--target", default="z_wasm_safepoint",
                    help="name of the function to call")
    ap.add_argument("--skip", action="append", default=[], metavar="EXPORT",
                    help="also leave this exported function alone; for names "
                         "only some builds have, and held to the same rule")
    args = ap.parse_args()
    skips = SKIP_EXPORTS + tuple(args.skip)

    lines = args.input.read_text().splitlines(keepends=True)
    exports = read_exports(lines)
    if args.target not in exports:
        sys.stderr.write(
            f"instrument_safepoints: {args.target} is not exported, so there is "
            "no way to name it here. Is CONFIG_WASM_SAFEPOINTS on?\n")
        return 1

    missing = [name for name in skips if name not in exports]
    if missing:
        sys.stderr.write(
            "instrument_safepoints: not exported, so these cannot be skipped "
            f"and would be instrumented: {', '.join(missing)}. Give each an "
            "export_name attribute or a --export at link, or stop skipping "
            "it.\n")
        return 1

    skip_idx = {exports[name] for name in skips}
    out, inserted, skipped = instrument(lines, exports[args.target], skip_idx)
    args.output.write_text("".join(out))
    print(f"instrument_safepoints: {inserted} loops instrumented, {skipped} skipped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
