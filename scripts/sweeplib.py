# SPDX-License-Identifier: Apache-2.0
"""What the sweeps have in common: build an application, run it, read the result.

scripts/check_kernel.py runs Zephyr's kernel test suites and
scripts/check_samples.py runs its samples. They differ in how they decide
whether something worked -- ztest's verdict, or a sample's own console
regex -- and in nothing else, so the building and running live here.
"""
import pathlib
import re
import subprocess

HERE = pathlib.Path(__file__).resolve().parent
MODULE = HERE.parent
TOP = MODULE.parent

ERROR_RE = re.compile(r"error: (.*)")

# The trap wasm raises when an indirect call's signature does not match the
# callee's: on this port, almost always a thread entry that is not exactly
# void (*)(void *, void *, void *). DESIGN.md D8b.
SIGNATURE_TRAP = "null function or function signature mismatch"

# What went wrong at run time, in the order worth reporting it. The boot
# banner is also *** wrapped ***, so this looks for trouble specifically
# rather than for the first thing shaped like a message.
RUN_TROUBLE_RE = re.compile(
    r"(RuntimeError: [^\n]*|\*\*\* (?:fatal|gave up|asyncify buffer overflow)[^\n]*)")


# This board's own files for an application, as upstream keeps native_sim's
# in the application's boards/ directory (DESIGN.md D12). They describe the
# devices a sample needs and set the options this board needs for it, and
# they are the only thing that may be added: an overlay and a Kconfig
# fragment, never source. APP_FILES/<path under the west topdir's zephyr/>/.
APP_FILES = MODULE / "boards" / "wasm" / "wasm_node" / "apps"
BOARD_FILES = ("wasm_node.overlay", "wasm_node.conf")


def board_files(app: str) -> dict[str, pathlib.Path]:
    """The board files this port supplies for app, by name; empty if none."""
    if not app.startswith("zephyr/"):
        return {}
    where = APP_FILES / app[len("zephyr/"):]
    if not where.is_dir():
        return {}
    other = sorted(p.name for p in where.iterdir() if p.name not in BOARD_FILES)
    if other:
        raise SystemExit(f"{where}: only {' and '.join(BOARD_FILES)} may be supplied for an "
                         f"application, not {', '.join(other)}")
    return {name: where / name for name in BOARD_FILES if (where / name).exists()}


def with_board_files(app: str, args) -> list[str]:
    """args with this board's files for app added the way Zephyr finds them.

    An application's boards/<board>.overlay replaces its app.overlay, unless
    the build names DTC_OVERLAY_FILE itself; boards/<board>.conf is merged
    after prj.conf and before any EXTRA_CONF_FILE. These do the same.
    """
    out = list(args)
    files = board_files(app)
    overlay = files.get("wasm_node.overlay")
    if overlay and not any(a.startswith("-DDTC_OVERLAY_FILE=") for a in out):
        out.append(f"-DDTC_OVERLAY_FILE={overlay}")
    conf = files.get("wasm_node.conf")
    if conf:
        for i, a in enumerate(out):
            if a.startswith("-DEXTRA_CONF_FILE="):
                out[i] = f"-DEXTRA_CONF_FILE={conf};{a.split('=', 1)[1]}"
                break
        else:
            out.append(f"-DEXTRA_CONF_FILE={conf}")
    return out


def build(app: str, build_dir: pathlib.Path, extra_args=()) -> tuple[bool, str, str]:
    """Build app into build_dir. Returns (ok, the first error line or '', log).

    This board's files for app, if it has any, are added (board_files())."""
    built = subprocess.run(
        [str(MODULE / "scripts" / "build.sh"), str(build_dir), app,
         *with_board_files(app, extra_args)],
        cwd=TOP, capture_output=True, text=True)
    log = built.stdout + built.stderr
    if built.returncode == 0:
        return True, "", log
    err = ERROR_RE.search(log)
    if err:
        return False, err.group(1).strip(), log
    tail = [line for line in log.strip().split("\n") if line.strip()]
    return False, (tail[-1] if tail else f"exit {built.returncode}"), log


def run(wasm: pathlib.Path, max_time_ms: int, args=(), timeout: int = 900,
        stdin: str | None = None) -> tuple[int, str]:
    """Run a built module under the Node host. Returns (exit code, all output).

    With stdin, the guest's UART reads it, which means --interactive: the run
    then goes on to max_time_ms rather than ending when the guest falls idle.
    """
    extra = ["--interactive"] if stdin is not None else []
    try:
        ran = subprocess.run(
            ["node", str(MODULE / "host" / "run.mjs"),
             "--max-time", str(max_time_ms), *extra, *args, str(wasm)],
            # A guest may print any byte at all -- a sample that dumps an
            # erased disk prints 0xff -- and a harness that dies on it
            # reports nothing about the sample.
            cwd=TOP, capture_output=True, text=True, errors="replace", timeout=timeout,
            input=stdin if stdin is not None else None,
            stdin=None if stdin is not None else subprocess.DEVNULL)
    except subprocess.TimeoutExpired as err:
        out = (err.stdout or b"").decode(errors="replace") if isinstance(err.stdout, bytes) \
            else (err.stdout or "")
        return 124, out + "\n*** gave up: wall-clock timeout in the sweep ***\n"
    return ran.returncode, ran.stdout + ran.stderr


def trouble(out: str) -> str:
    """The most telling line of a run that went wrong, or ''."""
    m = RUN_TROUBLE_RE.search(out)
    return m.group(1).removesuffix(" ***")[:160] if m else ""
