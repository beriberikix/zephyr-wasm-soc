#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Build and run Zephyr's own samples on wasm_node, judged by upstream's rules.

The measure issue #1 sets is upstream samples that run unmodified, and the
last round showed the main reason the number was low: nobody had tried.
Three of the five samples added then needed no work at all. This tries all
of them that could plausibly run here, and records what happened.

"Runs" is decided by upstream, not by this script. Most samples say in their
tests.yaml what a working run prints -- harness: console, with a regex -- and
that is the criterion twister applies on every other board. This applies the
same rules to the same patterns. A sample with no such criterion is recorded
as running, and does not count towards the score, for the same reason
basic/minimal never did.

Whether an entry runs on this board at all is upstream's call too. An entry
may carry a twister filter -- dt_alias_exists("accel0"), TOOLCHAIN_HAS_NEWLIB,
CONFIG_ARCH_HAS_USERSPACE -- which twister evaluates after CMake, against the
build's .config, CMake cache and devicetree, and an entry whose filter is false
is never run on that board. This evaluates the same expression with twister's
own parser against the same files, and records such an entry as filtered: not
a failure, and not a candidate.

Usage:
  scripts/check_samples.py --discover       refresh the candidate list
  scripts/check_samples.py [--match PREFIX] [--only path,path] [--update]

--match takes a path prefix and may be repeated, which is how the sweep runs
in batches (--match samples/subsys). --update writes each result into
scripts/samples.json as it arrives, so a long run that is interrupted keeps
what it had. Read the diff before committing it.
"""
import argparse
import json
import os
import pathlib
import pickle
import re
import shlex
import shutil
import sys

import yaml

import sweeplib

HERE = pathlib.Path(__file__).resolve().parent
TOP = sweeplib.TOP
ZEPHYR = TOP / "zephyr"
RECORD = HERE / "samples.json"

# What this board is, for scoped extra_args ("platform:<board>:ARG") and for
# the filter below.
BOARD = "wasm_node"
ARCH = "wasm"
SIMULATION = "custom"

# Features this board provides. A sample that depends on anything else needs
# hardware or a host peer this port does not have yet.
SUPPORTED = {"gpio", "entropy"}

# Harnesses that judge by console output or not at all. The rest need
# hardware or a peer on the other end: net, bluetooth, sensor, pytest...
RUNNABLE_HARNESS = {None, "console", "none", "shell"}

# A platform_allow naming one of these means upstream considers the sample
# runnable without hardware, which is the best evidence there is that it
# might run here.
SIMULATED = ("native_sim", "qemu_", "native_posix", "unit_testing")

GUEST_TIME_MS = 30_000

ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]")

# Build failures, most specific first. The first that matches is the cause.
BUILD_CAUSES = (
    ("module-missing", re.compile(
        r"(No module named|could not find .* module|ZEPHYR_\w+_MODULE_DIR|"
        r"fatal error: '(lvgl|nanopb|pb|arm_math|mbedtls|psa|tfm|littlefs|lfs|ff|"
        r"cmsis|hal_\w+|openthread|mcuboot)[^']*' file not found)", re.I)),
    ("kconfig", re.compile(r"(Aborting due to Kconfig warnings|"
                           r"was assigned the value .* but got the value|"
                           r"error: .*Kconfig)")),
    ("kconfig-symbol", re.compile(r"undeclared identifier 'CONFIG_\w+'")),
    ("devicetree", re.compile(r"(devicetree error|__device_dts_ord_\d+|DT_N_\w+|"
                              r"dts_ord|no such node)")),
    ("link", re.compile(r"(undefined symbol|wasm-ld: error)")),
    ("compile", re.compile(r"(error: |fatal error: )")),
)


def strip_ansi(text: str) -> str:
    return ANSI_RE.sub("", text)


# ----------------------------------------------------------------------------
# Discovery: which upstream samples are worth trying here, and why the others
# are not.


def _as_list(value) -> list:
    if value is None:
        return []
    if isinstance(value, str):
        return value.split()
    return list(value)


def upstream_entries():
    """Every sample test entry upstream declares, with common: merged in."""
    for f in sorted((ZEPHYR / "samples").rglob("tests.yaml")):
        doc = yaml.safe_load(f.read_text()) or {}
        common = doc.get("common") or {}
        app = str(f.parent.relative_to(TOP))
        for name, entry in (doc.get("tests") or {}).items():
            yield app, name, {**common, **(entry or {})}


def exclusion(app: str, entry: dict) -> str | None:
    """Why this entry cannot run here, or None if it might."""
    allowed = _as_list(entry.get("platform_allow"))
    if allowed and not any(any(s in p for s in SIMULATED) for p in allowed):
        return "platform_allow names only hardware"
    harness = entry.get("harness")
    if harness not in RUNNABLE_HARNESS:
        return f"harness {harness} needs hardware or a peer"
    missing = set(_as_list(entry.get("depends_on"))) - SUPPORTED
    if missing:
        return "depends_on a feature this board lacks"
    if app.startswith(("zephyr/samples/boards", "zephyr/samples/shields",
                       "zephyr/samples/soc")):
        return "board, shield or SoC specific"
    return None


def discover(record: dict) -> dict:
    """Refresh the candidate list, keeping every recorded result and note."""
    known = {(s["path"], s["entry"]): s for s in record.get("samples", [])}
    samples, excluded, apps, entries = [], {}, set(), 0
    for app, name, entry in upstream_entries():
        entries += 1
        apps.add(app)
        why = exclusion(app, entry)
        if why:
            excluded[why] = excluded.get(why, 0) + 1
            continue
        samples.append(known.get((app, name), {"path": app, "entry": name,
                                               "status": "untried"}))
    candidates = {s["path"] for s in samples}
    record["summary"] = {
        "upstream_apps": len(apps),
        "upstream_entries": entries,
        "candidate_apps": len(candidates),
        "candidate_entries": len(samples),
        "excluded_entries": dict(sorted(excluded.items(), key=lambda kv: -kv[1])),
    }
    record["samples"] = samples
    return record


# ----------------------------------------------------------------------------
# Running one entry the way upstream's own CI would.


def upstream_entry(app: str, name: str) -> dict:
    """Re-read the entry from upstream, so the criterion is always theirs."""
    doc = yaml.safe_load((TOP / app / "tests.yaml").read_text()) or {}
    return {**(doc.get("common") or {}), **((doc.get("tests") or {}).get(name) or {})}


def _applies(item: str) -> str | None:
    """Strip a "platform:<x>:" style scope, or drop the item if not ours."""
    parts = item.split(":", 2)
    if len(parts) == 3 and parts[0] in ("platform", "arch", "simulation"):
        ours = {"platform": BOARD, "arch": ARCH, "simulation": SIMULATION}[parts[0]]
        return parts[2] if parts[1].split("/")[0] == ours else None
    return item


def build_args(entry: dict) -> list[str]:
    """extra_args and extra_configs as cmake arguments, as twister passes them."""
    args = []
    raw = entry.get("extra_args") or []
    if isinstance(raw, str):
        raw = [raw]
    for item in raw:
        item = _applies(str(item))
        if item:
            # Twister strips the quotes and hands each to cmake as -D.
            args += [f"-D{a.replace(chr(34), '')}" for a in shlex.split(item)]
    for item in entry.get("extra_configs") or []:
        item = _applies(str(item))
        if item:
            args.append(f"-D{item}")
    return args


# Twister's own filter evaluation, from scripts/pylib/twister. Its parser and
# CMake cache reader are imported rather than copied, so an expression means
# here exactly what it means to twister.
sys.path.insert(0, str(ZEPHYR / "scripts" / "pylib" / "twister"))
sys.path.insert(0, str(ZEPHYR / "scripts" / "dts" / "python-devicetree" / "src"))
CONFIG_RE = re.compile(r'^(CONFIG_[A-Za-z0-9_]+)=\"?([^\"]*)\"?$')


def upstream_filter(entry: dict, build_dir: pathlib.Path) -> bool | None:
    """True if twister would run this entry here, False if it would not.

    None when there is no filter, or when the build stopped before CMake wrote
    what the filter reads, in which case twister would not have got as far as
    asking either.
    """
    expr = entry.get("filter")
    if not expr:
        return None
    config = build_dir / "zephyr" / ".config"
    if not config.exists():
        return None
    os.environ.setdefault("ZEPHYR_BASE", str(ZEPHYR))   # twisterlib insists
    import expr_parser
    from twisterlib.cmakecache import CMakeCache

    data = {"ARCH": ARCH, "PLATFORM": BOARD}
    data.update(os.environ)
    for line in config.read_text().splitlines():
        m = CONFIG_RE.match(line)
        if m:
            data[m.group(1)] = m.group(2).strip()
    try:
        data.update({k.name: k.value for k in CMakeCache.from_file(str(build_dir / "CMakeCache.txt"))})
    except FileNotFoundError:
        pass
    edt = None
    pickled = build_dir / "zephyr" / "edt.pickle"
    if pickled.exists():
        with open(pickled, "rb") as f:
            edt = pickle.load(f)
    return bool(expr_parser.parse(expr, data, edt))


def console_verdict(entry: dict, out: str) -> bool | None:
    """Twister's Console harness, applied to our output. None: no criterion.

    one_line searches each line for the first pattern. multi_line needs every
    pattern, in order line by line unless ordered is false. See
    scripts/pylib/twister/twisterlib/harness.py, class Console.
    """
    config = entry.get("harness_config") or {}
    patterns = config.get("regex") or []
    if entry.get("harness") != "console" or not patterns:
        return None
    lines = strip_ansi(out).splitlines()
    kind = config.get("type", "one_line")
    if kind == "one_line":
        pattern = re.compile(patterns[0])
        return any(pattern.search(line) for line in lines)
    compiled = [re.compile(p) for p in patterns]
    if config.get("ordered", True):
        want = 0
        for line in lines:
            if want < len(compiled) and compiled[want].search(line):
                want += 1
        return want == len(compiled)
    return all(any(p.search(line) for line in lines) for p in compiled)


def shell_commands(app: str, entry: dict) -> list[dict] | None:
    """Upstream's shell criterion: commands to type, each with an expected regex.

    Twister's Shell harness takes them from harness_config.shell_commands or
    from a test_shell.yml beside the sample. None when there are none.
    """
    config = entry.get("harness_config") or {}
    if config.get("shell_commands"):
        return config["shell_commands"]
    path = TOP / app / config.get("shell_commands_file", "test_shell.yml")
    if path.exists():
        return yaml.safe_load(path.read_text()) or None
    return None


def shell_verdict(commands: list[dict], out: str) -> bool:
    """Every expected pattern, in the order its command was typed."""
    text = strip_ansi(out)
    at = 0
    for step in commands:
        expected = step.get("expected")
        if not expected:
            continue
        m = re.compile(expected).search(text, at)
        if not m:
            return False
        at = m.end()
    return True


def run_cause(out: str) -> str:
    # V8 raises the same message for a call through a null pointer as for a
    # call with the wrong signature, so the trap alone cannot say which. The
    # first sweep tagged nine apps "d8b" on this basis and seven of them were
    # zbus reading garbage out of a section this port had put out of order.
    # What it was is decided by looking, and recorded in the note.
    if sweeplib.SIGNATURE_TRAP in out:
        return "indirect-call"
    if "RuntimeError" in out:
        return "trap"
    if "*** fatal" in out:
        return "fatal"
    if "*** gave up" in out:
        return "gave-up"
    return "regex-mismatch"


def kept_cause(sample: dict, cause: str) -> str:
    """The recorded cause where a re-run can only guess at it.

    d8b is only ever set by hand, after finding the non-conforming thread
    entry in the source. The trap cannot tell it from a null pointer, so a
    re-run must not demote it back to indirect-call. Any other change of
    cause is left to show.
    """
    if cause == "indirect-call" and sample.get("cause") == "d8b":
        return "d8b"
    return cause


def build_cause(error: str, log: str = "") -> str:
    """Why a build failed, judged by its first error line where possible.

    Scanning the whole log first was wrong: a build log mentions devicetree
    aliases and modules in passing, so "use of undeclared identifier
    CONFIG_FLASH_BASE_ADDRESS" came out as a devicetree failure. The error
    line says what actually went wrong. The log is consulted only for the two
    causes that announce themselves somewhere other than that line.
    """
    for cause, pattern in BUILD_CAUSES:
        if pattern.search(error):
            return cause
    for cause in ("kconfig", "module-missing"):
        if dict(BUILD_CAUSES)[cause].search(log):
            return cause
    return "other"


def run_one(sample: dict, keep: bool) -> dict:
    app, name = sample["path"], sample["entry"]
    entry = upstream_entry(app, name)
    result = {"path": app, "entry": name}
    if sample.get("note"):
        result["note"] = sample["note"]

    build_dir = TOP / f"build-sample-{name.replace('/', '_')}"
    shutil.rmtree(build_dir, ignore_errors=True)
    ok, err, log = sweeplib.build(app, build_dir, build_args(entry))
    if upstream_filter(entry, build_dir) is False:
        # Twister asks this after CMake and before compiling, so whether the
        # compile then worked is beside the point.
        if not keep:
            shutil.rmtree(build_dir, ignore_errors=True)
        result.update(status="filtered", cause="upstream filter", detail=entry["filter"][:160])
        return result
    if not ok:
        result.update(status="build-fails", cause=build_cause(err, log), detail=err[:160])
        return result

    if entry.get("build_only"):
        if not keep:
            shutil.rmtree(build_dir, ignore_errors=True)
        result.update(status="builds", cause="build_only upstream")
        return result

    commands = shell_commands(app, entry) if entry.get("harness") == "shell" else None
    if commands:
        typed = "".join(f"{step['command']}\n" for step in commands)
        code, out = sweeplib.run(build_dir / "zephyr" / "zephyr.wasm", 20_000, stdin=typed)
    else:
        code, out = sweeplib.run(build_dir / "zephyr" / "zephyr.wasm", GUEST_TIME_MS)
    if not keep:
        shutil.rmtree(build_dir, ignore_errors=True)

    verdict = shell_verdict(commands, out) if commands else console_verdict(entry, out)
    if verdict is True:
        result["status"] = "passes"
    elif "PROJECT EXECUTION SUCCESSFUL" in out:
        result.update(status="passes", cause="ztest")
    elif "PROJECT EXECUTION FAILED" in out:
        result.update(status="fails", cause="ztest")
    elif verdict is False:
        cause = kept_cause(sample, run_cause(out))
        status = "fails" if cause == "regex-mismatch" else "does-not-finish"
        result.update(status=status, cause=cause)
        trouble = sweeplib.trouble(out)
        if trouble:
            result["detail"] = trouble
    else:
        trouble = sweeplib.trouble(out)
        if trouble and "gave up after" not in trouble:
            result.update(status="does-not-finish", cause=kept_cause(sample, run_cause(out)),
                          detail=trouble)
        else:
            result.update(status="runs", cause="no upstream criterion")
    return result


# ----------------------------------------------------------------------------


# "filtered" sits between failing and working: an entry that stops failing
# because upstream would not run it here is not a regression, and one that
# stops passing for that reason is.
RANK = ["untried", "build-fails", "does-not-finish", "fails", "filtered", "runs", "builds", "passes"]


def score(record: dict) -> int:
    """Upstream sample apps with at least one entry passing upstream's criterion."""
    return len({s["path"] for s in record.get("samples", []) if s.get("status") == "passes"})


def save(record: dict):
    record["score"] = score(record)
    samples = record.get("samples", [])
    filtered = [s for s in samples if s.get("status") == "filtered"]
    if "summary" in record:
        # What is left once upstream's filters have had their say: the entries
        # twister itself would run on this board.
        live = [s for s in samples if s.get("status") != "filtered"]
        record["summary"]["filtered_entries"] = len(filtered)
        record["summary"]["runnable_entries"] = len(live)
        record["summary"]["runnable_apps"] = len({s["path"] for s in live})
    RECORD.write_text(json.dumps(record, indent=2) + "\n")


def use_record(path: str | None):
    """Point the sweep at a record other than the committed one.

    A full sweep writes its record after every result for hours. Writing the
    committed file means the working tree is never clean and every snapshot is
    a commit, so a long sweep writes to a copy and the copy is brought back in
    deliberately.
    """
    global RECORD
    if path:
        RECORD = pathlib.Path(path).resolve()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--discover", action="store_true",
                    help="refresh the candidate list from upstream tests.yaml")
    ap.add_argument("--match", action="append", default=[],
                    help="run entries whose path starts with this (repeatable)")
    ap.add_argument("--only", help="comma-separated sample paths or entry names")
    ap.add_argument("--untried", action="store_true", help="only entries never run")
    ap.add_argument("--recorded",
                    help="only entries currently recorded with one of these "
                         "comma-separated statuses, e.g. passes,runs. The weekly "
                         "CI job uses this to guard what works without spending "
                         "hours rebuilding what is known not to")
    ap.add_argument("--update", action="store_true",
                    help="write each result into samples.json as it arrives")
    ap.add_argument("--keep-builds", action="store_true")
    ap.add_argument("--record", help="read and write this record instead of "
                                     "scripts/samples.json")
    ap.add_argument("--reclassify", action="store_true",
                    help="re-derive build-failure causes from recorded error lines")
    args = ap.parse_args()
    use_record(args.record)

    record = json.loads(RECORD.read_text()) if RECORD.exists() else {}

    if args.reclassify:
        changed = 0
        for sample in record.get("samples", []):
            if sample.get("status") == "build-fails" and sample.get("detail"):
                cause = build_cause(sample["detail"])
                if cause != "other" and cause != sample.get("cause"):
                    sample["cause"] = cause
                    changed += 1
        save(record)
        print(f"reclassified {changed} build failures from their recorded error lines")
        return 0

    if args.discover:
        save(discover(record))
        s = record["summary"]
        print(f"{s['upstream_apps']} upstream sample apps, {s['upstream_entries']} entries; "
              f"{s['candidate_apps']} apps / {s['candidate_entries']} entries worth trying")
        for why, n in s["excluded_entries"].items():
            print(f"  {n:5} excluded: {why}")
        return 0

    chosen = record.get("samples", [])
    if args.match:
        # Recorded paths start at the west topdir; let "samples/kernel" mean
        # "zephyr/samples/kernel", which is what anyone would type.
        prefixes = [m if m.startswith("zephyr/") else f"zephyr/{m}" for m in args.match]
        chosen = [s for s in chosen if s["path"].startswith(tuple(prefixes))]
    if args.only:
        want = set(args.only.split(","))
        chosen = [s for s in chosen if s["path"] in want or s["entry"] in want]
    if args.untried:
        chosen = [s for s in chosen if s.get("status") == "untried"]
    if args.recorded:
        wanted = set(args.recorded.split(","))
        chosen = [s for s in chosen if s.get("status") in wanted]

    worse, better = [], []
    index = {(s["path"], s["entry"]): i for i, s in enumerate(record.get("samples", []))}
    for sample in chosen:
        got = run_one(sample, args.keep_builds)
        before = sample.get("status", "untried")
        mark = ""
        if before not in ("untried", got["status"]):
            if RANK.index(got["status"]) > RANK.index(before):
                better.append(sample["entry"])
                mark = f"   (better than recorded: {before})"
            else:
                worse.append(sample["entry"])
                mark = f"   <-- RECORDED AS {before}"
        why = got.get("cause", "")
        detail = got.get("detail", "")
        print(f"  {got['status']:<16} {sample['entry']:<48} {why} {detail}{mark}".rstrip(),
              flush=True)
        if args.update:
            record["samples"][index[(sample["path"], sample["entry"])]] = got
            save(record)

    if args.update:
        print(f"\nscore: {score(record)} upstream samples pass their own criterion")
    if worse:
        print(f"{len(worse)} entr{'y' if len(worse) == 1 else 'ies'} did worse than recorded: "
              + ", ".join(worse))
        return 1
    if better and not args.update:
        print(f"{len(better)} did better than recorded; record it with --update")
    return 0


if __name__ == "__main__":
    sys.exit(main())
