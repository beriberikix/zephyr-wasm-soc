#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Build the linker-section symbols the kernel needs, without a linker script.

Zephyr places three kinds of thing with linker-script magic that wasm-ld has no
equivalent for:

  * SYS_INIT entries, which must form one contiguous block ordered by level and
    then priority, because z_sys_init_run_level() walks from one level's start
    symbol to the next one's.
  * iterable sections, which need only a start and an end symbol.

wasm-ld does synthesise __start_/__stop_ for sections whose names are C
identifiers, but it never orders segments by name and Zephyr's section names
contain dots, so neither half comes for free (see spike A).

This script reads the wasm objects, recovers each entry's level and priority
from the segment name Zephyr already encodes, and writes a C file that:

  * defines the six per-level arrays adjacently in one translation unit, which
    lands them contiguous and in order, and
  * fills them at boot by copying each entry into its sorted place.

Copying is safe because nothing holds a pointer to an init entry. The arrays
are sized here, at build time, so the copy is a fixed sequence of assignments
with no allocation and no sorting at run time.
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

# Iterable sections that need only bounds. Mapping from the section name Zephyr
# uses to the start/end symbols the kernel declares.
# Section base name -> (element type, start symbol, end symbol). The symbol
# names follow TYPE_SECTION_START/END in iterable_sections.h.
ITERABLES = {
    "_static_thread_data": ("struct _static_thread_data",
                            "__static_thread_data_list_start",
                            "__static_thread_data_list_end"),
    # STRUCT_SECTION_ITERABLE names the section after the struct, so the type
    # is the section key without its leading underscore.
    "k_kernel_init_pre_entry": ("struct k_kernel_init_pre_entry",
                                 "_k_kernel_init_pre_entry_list_start",
                                 "_k_kernel_init_pre_entry_list_end"),
    "k_kernel_init_post_entry": ("struct k_kernel_init_post_entry",
                                  "_k_kernel_init_post_entry_list_start",
                                  "_k_kernel_init_post_entry_list_end"),
}


ITER_REF_RE = re.compile(r"__(?:start|stop)_(z_iter_\w+)")
ITER_DEF_RE = re.compile(r"^\s+-\s+\d+:\s+(z_iter_\w+)\s", re.M)


def scan_iter_sections(objdump: str, path: Path) -> tuple[set[str], set[str]]:
    """Return (sections referenced, sections actually defined) for one object.

    The distinction decides whether a family needs a fallback definition. A
    weak fallback for a section that does exist would be worse than useless:
    it gives wasm-ld a definition and so suppresses the synthesised bounds,
    leaving the list permanently empty.
    """
    proc = subprocess.run([objdump, "-x", str(path)], capture_output=True, text=True)
    if proc.returncode != 0:
        return set(), set()
    return set(ITER_REF_RE.findall(proc.stdout)), set(ITER_DEF_RE.findall(proc.stdout))


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
    iterables = {key: [] for key in ITERABLES}
    iter_refs: set[str] = set()
    iter_defs: set[str] = set()
    for path in paths:
        refs, defs = scan_iter_sections(objdump, path)
        iter_refs |= refs
        iter_defs |= defs
        for name, seg in scan_object(objdump, path):
            m = INIT_SEG_RE.match(seg)
            if m and m.group("level") in LEVELS:
                init_entries.append((m.group("level"), int(m.group("prio")),
                                     int(m.group("sub")), name))
                continue
            for key in iterables:
                # e.g. ._static_thread_data.static.foo_
                if seg == f"z_iter_{key}":
                    iterables[key].append(name)
    # Only a family that is referenced and never defined needs a fallback.
    return init_entries, iterables, sorted(iter_refs - iter_defs)


def render_bounds(iter_refs) -> str:
    """The weak bound fallbacks, in a file of their own.

    These cannot live beside the init arrays: that file includes Zephyr
    headers, which declare some of the same symbols with real element types,
    and a second declaration as char[0] is a conflict.

    Many of these lists are deliberately pay-per-use, so a build that never
    uses mailboxes has no mailbox entry and the section does not exist at all.
    A linker script would yield an empty range; wasm-ld instead fails on a
    reference to the bounds of a section nothing defines. A weak, zero-length
    definition covers that: where the section really exists wasm-ld's own
    strong symbols win, and where it does not, start and end land at the same
    address and the list reads as the empty list it is.
    """
    out = ["/* Generated by scripts/gen_sections_wasm.py. Do not edit. */", ""]
    for sec in iter_refs:
        out.append(f"__attribute__((weak, used)) char __start_{sec}[0];")
        out.append(f"__attribute__((weak, used)) char __stop_{sec}[0];")
    out.append("")
    return "\n".join(out)


def render(init_entries, iterables, iter_refs) -> str:
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
    out.append("/* The kernel's own init lists are pay-per-use: their entries live only in")
    out.append(" * objects the link may never pull in, so the section can be defined in")
    out.append(" * some object and still be absent from the image. A weak bound fallback")
    out.append(" * cannot cover that, because it would also suppress the real bounds")
    out.append(" * wherever the section does exist. An anchor member is unambiguous: it")
    out.append(" * keeps the section present, and its function does nothing. */")
    out.append("static void z_wasm_anchor_fn(void) { }")
    for key, ctype in (("k_kernel_init_pre_entry", "struct k_kernel_init_pre_entry"),
                       ("k_kernel_init_post_entry", "struct k_kernel_init_post_entry")):
        out.append(f'__attribute__((section("z_iter_{key}"), used))')
        out.append(f"const {ctype} z_wasm_anchor_{key} = {{ .init_fn = z_wasm_anchor_fn }};")
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
        tmp = tempfile.mkdtemp(prefix="wasm_sections_")
        for archive in sorted(args.scan_dir.rglob("*.a")):
            subprocess.run([args.ar, "x", "--output", tmp, str(archive)],
                           capture_output=True, check=False)
        paths += sorted(Path(tmp).glob("*.obj")) + sorted(Path(tmp).glob("*.o"))
    paths = [p for p in paths if p.suffix in (".obj", ".o") and p.exists()]
    if not paths:
        sys.stderr.write("gen_sections_wasm: no objects to scan\n")
        return 1

    init_entries, iterables, iter_refs = collect(args.objdump, paths)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(render(init_entries, iterables, iter_refs))
    bounds = args.output.with_name("wasm_section_bounds.c")
    bounds.write_text(render_bounds(iter_refs))
    if tmp:
        shutil.rmtree(tmp, ignore_errors=True)
    print(f"gen_sections_wasm: {len(init_entries)} init entries, {len(iter_refs)} iterable "
          f"families, from {len(paths)} objects")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
