#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Check from the link map that every iterable section is laid out as upstream's.

gen_sections_wasm.py orders each iterable family by linking a file ahead of
everything that names the family's sections in key order, between a start and
a stop marker. That only works if wasm-ld saw that file first and if the scan
that wrote it saw every object that got linked. If either is not so, an entry
lands outside its list's bounds and the list is silently shorter, which is the
failure mode that is hardest to notice. So this reads the map wasm-ld wrote and
fails the build unless, for every family:

  * its output segments are one unbroken run: the start marker, the keys in
    byte order, then the stop marker, with nothing else among them;
  * each segment starts exactly where the previous one ended, so walking the
    list by element size visits every entry and nothing else.

Usage: check_sections_wasm.py <link map>
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

# An output segment line:     400       7c        0 z_iter_fam.
# Input sections and symbols follow it, further indented.
OUT_RE = re.compile(r"^\s*([0-9a-f]+)\s+[0-9a-f]+\s+([0-9a-f]+) (\S.*)$")
FAMILY_RE = re.compile(r"^z_iter_(\w+)\.(.*)$")
STOP = "~"   # as in gen_sections_wasm.py


def output_segments(map_text: str) -> list[tuple[str, int, int]]:
    """(name, address, size) of each data output segment, in layout order."""
    segs = []
    in_data = False
    for line in map_text.splitlines():
        fields = line.split()
        if len(fields) == 4 and fields[0] == "-":
            # A wasm section header has no address: "   -   7b   36 DATA".
            in_data = fields[3] == "DATA"
            continue
        m = OUT_RE.match(line)
        if m and in_data:
            segs.append((m.group(3), int(m.group(1), 16), int(m.group(2), 16)))
    return segs


def check(segs: list[tuple[str, int, int]]) -> list[str]:
    problems = []
    runs: dict[str, list[tuple[int, str, int, int]]] = {}
    for i, (name, addr, size) in enumerate(segs):
        if name.startswith("z_iter_"):
            m = FAMILY_RE.match(name)
            if not m:
                problems.append(f"{name}: an iterable section with no key; "
                                "was it placed by something other than patch 0004?")
                continue
            runs.setdefault(m.group(1), []).append((i, m.group(2), addr, size))

    for fam, run in sorted(runs.items()):
        keys = [key for _, key, _, _ in run]
        if keys[0] != "" or keys[-1] != STOP:
            problems.append(f"{fam}: not bracketed by its markers (first {keys[0]!r}, "
                            f"last {keys[-1]!r}); the generated layout was not linked first")
            continue
        body = keys[1:-1]
        if body != sorted(body, key=lambda k: k.encode()):
            problems.append(f"{fam}: entries out of key order: {body}")
        idx = [i for i, _, _, _ in run]
        if idx != list(range(idx[0], idx[0] + len(idx))):
            stray = [segs[i][0] for i in range(idx[0], idx[-1]) if i not in idx]
            problems.append(f"{fam}: other segments inside the list: {stray}")
        for (_, k0, a0, s0), (_, k1, a1, _) in zip(run, run[1:]):
            if a1 != a0 + s0:
                problems.append(f"{fam}: {a1 - a0 - s0} bytes between {k0!r} and {k1!r}; "
                                "the list would walk through them")
                break
    return problems


def main() -> int:
    if len(sys.argv) != 2:
        sys.stderr.write(__doc__)
        return 2
    segs = output_segments(Path(sys.argv[1]).read_text())
    problems = check(segs)
    for p in problems:
        sys.stderr.write(f"check_sections_wasm: {p}\n")
    if problems:
        sys.stderr.write("check_sections_wasm: iterable sections are not laid out as "
                         "upstream's linker script would; see DESIGN.md D6\n")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
