#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""A second host, on a second engine.

`host/run.mjs` is the real harness. This one exists to answer a narrower
question: is the module engine-neutral, or has it quietly grown a dependency
on V8? It implements the same `zephyr_host` ABI and the same Asyncify driver
loop against wasmtime, in about a fifth of the code, because it leaves out
everything interactive.

Usage: run_wasmtime.py [--max-time MS] <zephyr.wasm>
"""
from __future__ import annotations

import argparse
import struct
import sys
from pathlib import Path

from wasmtime import Engine, FuncType, Func, Instance, Module, Store, ValType

NORMAL, UNWINDING, REWINDING = 0, 1, 2

CLAMP_NS = 100_000_000_000
SAFEPOINT_TICK_NS = 100_000
QUIESCENT_ROUNDS = 2

I32 = ValType.i32()
I64 = ValType.i64()


class GaveUp(Exception):
    """Raised out of an import to stop a guest that will not stop by itself."""


class Host:
    def __init__(self, path: Path, max_time_ms: int):
        self.max_time_ns = max_time_ms * 1_000_000
        self.now_ns = 0
        self.alarm_ns: int | None = None
        self.alarm_is_clamp = False
        self.quiescent = 0
        self.done = False
        self.exit_code = 0
        self.contexts: dict[int, dict] = {}
        self.resume_same = False
        self.unwound_into = None
        self.pending_fatal = False
        self.out = bytearray()

        self.store = Store(Engine())
        self.module = Module.from_file(self.store.engine, str(path))
        self.instance = Instance(self.store, self.module, self._imports())
        self.ex = self.instance.exports(self.store)
        self.mem = self.ex["memory"]
        self.sp = self.ex["__stack_pointer"]

    # --- memory helpers -------------------------------------------------
    def u32(self, addr: int) -> int:
        return struct.unpack("<I", self.mem.read(self.store, addr, addr + 4))[0]

    def set_u32(self, addr: int, value: int) -> None:
        self.mem.write(self.store, struct.pack("<I", value & 0xFFFFFFFF), addr)

    def call(self, name: str, *args):
        return self.ex[name](self.store, *args)

    # --- the zephyr_host ABI --------------------------------------------
    def _imports(self):
        def console_write(ptr, length):
            self.out += self.mem.read(self.store, ptr, ptr + length)
            sys.stdout.write(self.out.decode("utf-8", "replace"))
            sys.stdout.flush()
            self.out.clear()

        def time_now_ns():
            return self.now_ns

        def set_alarm_ns(deadline):
            self.alarm_is_clamp = deadline >= CLAMP_NS
            self.alarm_ns = None if deadline >= 0x7FFFFFFFFFFFFFFF else deadline

        def wait_for_event():
            if self.call("asyncify_get_state") == REWINDING:
                self.call("asyncify_stop_rewind")
                return
            self.suspend(idle=True)

        def switch_to():
            if self.call("asyncify_get_state") == REWINDING:
                self.call("asyncify_stop_rewind")
                return
            self.suspend(idle=False)

        def safepoint_tick():
            self.now_ns += SAFEPOINT_TICK_NS
            # The only place a guest that never suspends can be stopped. The
            # check between steps below cannot reach one, because such a guest
            # never ends a step. This import cannot suspend, so raising is the
            # way out; the instance is finished either way.
            self.check_deadline()
            if self.alarm_ns is not None and self.now_ns >= self.alarm_ns:
                self.alarm_ns = None
                self.quiescent = 0
                self.raise_irq(0)

        def fatal(reason, arg):
            sys.stderr.write(f"\n*** fatal: reason {reason} (arg {arg}) ***\n")
            self.done = True
            self.exit_code = 1
            self.suspend(idle=False, fatal=True)

        def uart_poll_out(c):
            sys.stdout.write(chr(c & 0xFF))
            sys.stdout.flush()

        def uart_poll_in():
            return -1          # no input: this host is not interactive

        impls = {
            "console_write": (console_write, [I32, I32], []),
            "time_now_ns": (time_now_ns, [], [I64]),
            "set_alarm_ns": (set_alarm_ns, [I64], []),
            "wait_for_event": (wait_for_event, [], []),
            "switch_to": (switch_to, [], []),
            "safepoint_tick": (safepoint_tick, [], []),
            "fatal": (fatal, [I32, I32], []),
            "uart_poll_out": (uart_poll_out, [I32], []),
            "uart_poll_in": (uart_poll_in, [], [I32]),
        }

        # Imports are positional, so build the list in the order the module
        # declares them rather than in the order they are written above.
        out = []
        for imp in self.module.imports:
            if imp.module != "zephyr_host" or imp.name not in impls:
                raise SystemExit(f"module wants an import this host does not provide: "
                                 f"{imp.module}.{imp.name}")
            fn, params, results = impls[imp.name]
            out.append(Func(self.store, FuncType(params, results), fn))
        return out

    # --- the Asyncify driver loop ---------------------------------------
    def suspend(self, idle: bool, fatal: bool = False):
        blk = self.switch_block()
        from_buf = self.current["buf"] if (idle or fatal) else (blk[1] or self.scratch)
        self.current_sp = self.sp.value(self.store)
        self.resume_same = idle
        self.pending_fatal = fatal
        self.unwound_into = from_buf
        self.call("asyncify_start_unwind", from_buf)

    def switch_block(self):
        base = self.block_addr
        return [self.u32(base + 4 * i) for i in range(6)]

    def raise_irq(self, line: int):
        self.set_u32(self.irq_addr, self.u32(self.irq_addr) | (1 << line))

    def advance(self) -> bool:
        if self.alarm_ns is None:
            return False
        self.quiescent = self.quiescent + 1 if self.alarm_is_clamp else 0
        if self.quiescent > QUIESCENT_ROUNDS:
            return False
        self.now_ns = max(self.now_ns, self.alarm_ns)
        self.alarm_ns = None
        self.raise_irq(0)
        return True

    def step(self) -> bool:
        c = self.current
        if not c["fresh"]:
            self.sp.set_value(self.store, c["sp"])
            self.call("asyncify_start_rewind", c["buf"])
        elif c["sp"] is not None:
            self.sp.set_value(self.store, c["sp"])
        c["fresh"] = False

        # z_wasm_boot takes no argument and z_wasm_thread_entry takes one.
        # JavaScript ignores a surplus argument; wasmtime rejects it, which is
        # the first real difference between the two engines this found.
        if c["entry"] == "z_wasm_boot":
            self.call(c["entry"])
        else:
            self.call(c["entry"], c["arg"])

        if self.call("asyncify_get_state") != UNWINDING:
            return False
        self.call("asyncify_stop_unwind")
        if self.pending_fatal:
            return False

        c["sp"] = self.current_sp
        if self.unwound_into is not None:
            c["buf"] = self.unwound_into
        self.contexts[c["buf"]] = c

        if self.resume_same:
            if self.u32(self.irq_addr) == 0 and not self.advance():
                return False
            return True

        _, _, to_sp, to_buf, to_fresh, to_arg = self.switch_block()
        if to_fresh:
            self.current = {"entry": "z_wasm_thread_entry", "arg": to_arg,
                            "buf": to_buf, "sp": to_sp, "fresh": True}
        else:
            known = self.contexts.get(to_buf)
            if known is None:
                raise SystemExit(f"asked to resume unknown context 0x{to_buf:x}")
            self.current = known
        return True

    def check_deadline(self):
        if self.now_ns > self.max_time_ns:
            raise GaveUp(f"gave up after {self.max_time_ns // 1_000_000} ms of guest time")

    def run(self) -> int:
        self.block_addr = self.call("z_wasm_switch_block_addr")
        self.irq_addr = self.call("z_wasm_irq_pending_addr")
        self.scratch = self.call("z_wasm_boot_scratch_addr")
        self.current = {"entry": "z_wasm_boot", "arg": 0, "buf": self.scratch,
                        "sp": None, "fresh": True}
        while not self.done:
            try:
                self.check_deadline()
                if not self.step():
                    break
            except GaveUp as gave_up:
                sys.stderr.write(f"\n*** {gave_up} ***\n")
                return 2
        return self.exit_code


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("wasm", type=Path)
    ap.add_argument("--max-time", type=int, default=10_000, help="guest time limit in ms")
    args = ap.parse_args()
    return Host(args.wasm, args.max_time).run()


if __name__ == "__main__":
    raise SystemExit(main())
