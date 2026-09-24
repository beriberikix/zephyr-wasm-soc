#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Build the linker-section symbols the kernel needs, without a linker script.

Zephyr places three kinds of thing with linker-script magic that wasm-ld has no
equivalent for:

  * SYS_INIT entries, which must form one contiguous block ordered by level and
    then priority, because z_sys_init_run_level() walks from one level's start
    symbol to the next one's.
  * iterable sections, which the ELF scripts collect with SORT_BY_NAME, so
    that each family is one contiguous list in name order. Some lists depend
    on that order: zbus finds a channel's observers by it.

wasm-ld never orders segments by name (see spike A), so neither half comes for
free.

For init entries this script recovers each entry's level and priority from the
segment name Zephyr already encodes, and writes a C file that:

  * defines the six per-level arrays adjacently in one translation unit, which
    lands them contiguous and in order, and
  * fills them at boot by copying each entry into its sorted place.

Copying is safe because nothing holds a pointer to an init entry. The arrays
are sized here, at build time, so the copy is a fixed sequence of assignments
with no allocation and no sorting at run time.

Iterable entries cannot be copied, because plenty of code holds pointers to
them. They are ordered where they are instead. Patch 0004 names each entry's
section z_iter_<family>.<key>, with the key the ELF name sorts on. wasm-ld
makes one output segment per section name, in the order it first sees each
name, and lays them out one after another. So a file linked ahead of
everything else that mentions every family's names in sorted order decides the
layout: a zero-length start marker, a zero-length placeholder per key, and a
zero-length stop marker. Every real entry then lands in its key's segment,
between the markers, in upstream's order. scripts/check_sections_wasm.py reads
the link map afterwards and fails the build if any entry did not.
"""
from __future__ import annotations

import argparse
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

LEVELS = ["EARLY", "PRE_KERNEL_1", "PRE_KERNEL_2", "POST_KERNEL", "APPLICATION"]

# .z_init_<LEVEL>_P_<prio>_SUB_<sub>_
INIT_SEG_RE = re.compile(r"^\.z_init_(?P<level>[A-Z_0-9]+)_P_(?P<prio>\d+)_SUB_(?P<sub>\d+)_$")
SYM_RE = re.compile(r"^\s+-\s+\d+:\s+D\s+<(?P<name>[^>]+)>\s+segment=(?P<seg>\d+)")
SEG_RE = re.compile(r"^\s+-\s+(?P<idx>\d+):\s+(?P<name>\S+)\s")

ITER_REF_RE = re.compile(r"__(?:start|stop)_z_iter_(\w+)")
# A line of the linking section's segment info:  - 3: z_iter_k_msgq.my_q_ p2align=2
ITER_SEG_RE = re.compile(r"^\s+-\s+\d+:\s+z_iter_(\w+)\.(\S+)\s+p2align=(\d+)", re.M)


def scan_iter_sections(objdump: str, path: Path) -> tuple[set[str], dict[str, tuple[set[str], int]]]:
    """Return (families referenced, {family: (keys, largest p2align)}) for one object."""
    proc = subprocess.run([objdump, "-x", str(path)], capture_output=True, text=True)
    if proc.returncode != 0:
        return set(), {}
    defs: dict[str, tuple[set[str], int]] = {}
    for fam, key, p2 in ITER_SEG_RE.findall(proc.stdout):
        keys, align = defs.get(fam, (set(), 0))
        keys.add(key)
        defs[fam] = (keys, max(align, int(p2)))
    return set(ITER_REF_RE.findall(proc.stdout)), defs


def scan_object(objdump: str, path: Path) -> list[tuple[str, str]]:
    """Return (symbol name, segment name) for every data symbol in one object."""
    proc = subprocess.run([objdump, "-x", str(path)], capture_output=True, text=True)
    if proc.returncode != 0:
        return []

    syms: list[tuple[str, int]] = []
    segs: dict[int, str] = {}
    section = None
    for line in proc.stdout.splitlines():
        if "symbol table" in line:
            section = "syms"
            continue
        if "segment info" in line:
            section = "segs"
            continue
        if line.startswith("Custom") or line.startswith("Code"):
            section = None
            continue
        if section == "syms":
            m = SYM_RE.match(line)
            if m:
                syms.append((m.group("name"), int(m.group("seg"))))
        elif section == "segs":
            m = SEG_RE.match(line)
            if m:
                segs[int(m.group("idx"))] = m.group("name")
    return [(name, segs[seg]) for name, seg in syms if seg in segs]


def collect(objdump: str, paths: list[Path]):
    init_entries = []   # (level, prio, sub, symbol)
    families: dict[str, tuple[set[str], int]] = {}
    for path in paths:
        refs, defs = scan_iter_sections(objdump, path)
        # A family that is only referenced still needs its bounds: many lists
        # are pay-per-use, and one with no entries is the empty list.
        for fam in refs:
            families.setdefault(fam, (set(), 0))
        for fam, (keys, align) in defs.items():
            have, a = families.get(fam, (set(), 0))
            families[fam] = (have | keys, max(a, align))
        for name, seg in scan_object(objdump, path):
            m = INIT_SEG_RE.match(seg)
            if m and m.group("level") in LEVELS:
                init_entries.append((m.group("level"), int(m.group("prio")),
                                     int(m.group("sub")), name))
    return init_entries, families


# The stop marker's section. Any name works, because the layout follows the
# order names are first seen, not the names; this one reads as "after
# everything" and cannot be a key, since keys end in "_".
STOP = "~"


def render_bounds(families) -> str:
    """Every iterable family's layout, in a file linked ahead of everything.

    This file cannot include Zephyr headers: they declare the same bound
    symbols with real element types, and a second declaration as char[0] is a
    conflict. Nothing here needs a type, only an address.

    Keys sort bytewise, as SORT_BY_NAME compares the ELF section names: those
    share a prefix up to the key, so their order is the keys' order. The
    markers take the family's largest alignment, so the start cannot land on
    padding the linker inserts before the first entry.
    """
    out = ["/* Generated by scripts/gen_sections_wasm.py. Do not edit. */", ""]
    n = 0
    for fam in sorted(families):
        keys, p2align = families[fam]
        align = 1 << p2align
        out.append(f'__attribute__((section("z_iter_{fam}."), used, aligned({align}))) '
                   f"char __start_z_iter_{fam}[0];")
        for key in sorted(keys, key=lambda k: k.encode()):
            out.append(f'__attribute__((section("z_iter_{fam}.{key}"), used)) '
                       f"static char z_wasm_iter_{n}[0];")
            n += 1
        out.append(f'__attribute__((section("z_iter_{fam}.{STOP}"), used, aligned({align}))) '
                   f"char __stop_z_iter_{fam}[0];")
    out.append("")
    return "\n".join(out)


def render(init_entries) -> str:
    by_level = {level: [] for level in LEVELS}
    for level, prio, sub, sym in init_entries:
        by_level[level].append((prio, sub, sym))
    for level in LEVELS:
        # The order the linker script would have produced.
        by_level[level].sort(key=lambda e: (e[0], e[1], e[2]))

    out = [
        "/* Generated by scripts/gen_sections_wasm.py. Do not edit.",
        " *",
        " * Stands in for the parts of Zephyr's linker script that place init",
        " * entries and iterable sections, which wasm-ld cannot express.",
        " */",
        "",
        "#include <zephyr/kernel.h>",
        "#include <zephyr/init.h>",
        "#include <zephyr/device.h>",
        "#include <kernel_internal.h>",
        "#include <kernel_internal.h>",
        "",
    ]

    for level in LEVELS:
        for _, _, sym in by_level[level]:
            out.append(f"extern const struct init_entry {sym};")
    out.append("")

    out.append("/* One explicit section, declared in level order.")
    out.append(" *")
    out.append(" * Adjacency in the source is not enough on its own: as plain globals")
    out.append(" * these would land in .bss, where the linker is free to order and pad")
    out.append(" * them as it likes, and z_sys_init_run_level() walks from one level's")
    out.append(" * start to the next, so a reordering silently makes one level's range")
    out.append(" * cover another level's entries. Naming a section pins the order. */")
    out.append("#define Z_WASM_INIT_ARR __attribute__((section(\"z_initarr\"), used, aligned(4)))")
    out.append("")
    out.append("/* A level with no entries still needs a real array. A zero-length one")
    out.append(" * may not be emitted at all, which leaves its symbol at an address the")
    out.append(" * linker chose for something else, and the walk then covers whatever")
    out.append(" * happens to follow. One no-op entry costs a call and keeps every")
    out.append(" * level's address well defined. */")
    out.append("static int z_wasm_init_nop(void) { return 0; }")
    out.append("")
    for level in LEVELS:
        # A level with no entries must be zero-length, so its start coincides
        # with the next level's. Rounding up to one leaves a zeroed entry in
        # the walked range, and calling its null init_fn is an indirect call
        # to table slot 0, which traps as a signature mismatch rather than
        # faulting the way it would on hardware.
        n = max(len(by_level[level]), 1)
        out.append(f"Z_WASM_INIT_ARR struct init_entry __init_{level}_start[{n}];")
    out.append("Z_WASM_INIT_ARR struct init_entry __init_end[1];")
    out.append("")

    out.append("/* Called before z_cstart(). Copies each entry into the slot the")
    out.append(" * linker script would have placed it in. Nothing points at an init")
    out.append(" * entry, so moving them is safe. */")
    out.append("void z_wasm_init_sections(void)")
    out.append("{")
    for level in LEVELS:
        entries = by_level[level]
        if not entries:
            out.append(f"\t__init_{level}_start[0].init_fn = z_wasm_init_nop;   /* {level}: no entries */")
            out.append(f"\t__init_{level}_start[0].dev = NULL;")
            continue
        for i, (prio, sub, sym) in enumerate(entries):
            out.append(f"\t__init_{level}_start[{i}] = {sym};   /* priority {prio}.{sub} */")
    out.append("}")
    out.append("")
    return "\n".join(out)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("-o", "--output", required=True, type=Path)
    ap.add_argument("--objdump", default="wasm-objdump")
    ap.add_argument("objects", nargs="*", type=Path)
    ap.add_argument("--objects-from", type=Path,
                    help="file listing object paths, one per line")
    ap.add_argument("--scan-dir", type=Path,
                    help="directory to walk for the archives that get linked")
    ap.add_argument("--ar", default="llvm-ar", help="archiver, for listing archive members")
    args = ap.parse_args()

    paths = list(args.objects)
    if args.objects_from and args.objects_from.exists():
        paths += [Path(p) for p in args.objects_from.read_text().split() if p]
    tmp = None
    if args.scan_dir:
        # Scan the archives, not loose object files.
        #
        # A build directory keeps objects from sources that are no longer
        # compiled in: turn a driver off and its old .obj stays on disk.
        # Scanning those makes the generator emit references to symbols that
        # are not in the image, and the link fails on them. The archives are
        # rebuilt from the current source list, so they are the honest view of
        # what is about to be linked.
        #
        # One directory per archive, because member names collide. An
        # application's source is very often named after the thing it
        # exercises -- bitarray.c, timer.c, mutex.c -- and Zephyr has a source
        # of that name too, so extracting every archive into one directory
        # silently overwrote one with the other. Whichever lost the race had
        # its iterable-section entries disappear from this scan, and its
        # list came out empty. That is how a parameterised ztest suite ran
        # once with a null parameter instead of seven times with its values.
        # check_sections_wasm.py now catches that class of mistake at link.
        tmp = tempfile.mkdtemp(prefix="wasm_sections_")
        for n, archive in enumerate(sorted(args.scan_dir.rglob("*.a"))):
            into = Path(tmp) / f"{n:03d}-{archive.stem}"
            into.mkdir()
            subprocess.run([args.ar, "x", "--output", str(into), str(archive)],
                           capture_output=True, check=False)
        paths += sorted(Path(tmp).rglob("*.obj")) + sorted(Path(tmp).rglob("*.o"))
    paths = [p for p in paths if p.suffix in (".obj", ".o") and p.exists()]
    if not paths:
        sys.stderr.write("gen_sections_wasm: no objects to scan\n")
        return 1

    init_entries, families = collect(args.objdump, paths)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(render(init_entries))
    bounds = args.output.with_name("wasm_section_bounds.c")
    bounds.write_text(render_bounds(families))
    if tmp:
        shutil.rmtree(tmp, ignore_errors=True)
    print(f"gen_sections_wasm: {len(init_entries)} init entries, {len(families)} iterable "
          f"families, from {len(paths)} objects")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
