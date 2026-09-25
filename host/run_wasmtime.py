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
import os
import sys
from pathlib import Path

from wasmtime import Engine, FuncType, Func, Instance, Module, Store, ValType

NORMAL, UNWINDING, REWINDING = 0, 1, 2

CLAMP_NS = 100_000_000_000
SAFEPOINT_TICK_NS = 100_000
QUIESCENT_ROUNDS = 2

I32 = ValType.i32()
I64 = ValType.i64()


# Must match include/zephyr/arch/wasm/wasm_irq_lines.h, which is the
# authority, and host/irq_lines.mjs, which carries the same values again
# because this host is deliberately a separate implementation.
IRQ_TIMER = 0
IRQ_GPIO = 1
IRQ_INPUT = 2

# Must match DEFAULT_SEED and nextRandomByte() in host/core.mjs: a build that
# prints random numbers has to print the same ones under both hosts, which is
# what the two-engine check compares.
DEFAULT_SEED = 0x5EED0001


class GaveUp(Exception):
    """Raised out of an import to stop a guest that will not stop by itself."""


class Reboot(Exception):
    """Raised out of the reboot import; the instance it leaves is discarded."""


MAX_REBOOTS = 64   # as maxReboots in host/core.mjs


class Host:
    def __init__(self, path: Path, max_time_ms: int, trace_gpio: bool = False,
                 seed: int | None = None, true_random: bool = False,
                 flash_file: Path | None = None):
        self.max_time_ns = max_time_ms * 1_000_000
        self.trace_gpio = trace_gpio
        self.true_random = true_random
        self.rand_state = (seed if seed is not None else DEFAULT_SEED) & 0xFFFFFFFF or DEFAULT_SEED
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
        # The simulated flash: attached by the guest at boot, filled from the
        # image if there is one, carried across reboots, saved at the end.
        self.flash_file = flash_file
        self.storage: tuple[int, int] | None = None
        self.storage_image = (flash_file.read_bytes()
                              if flash_file is not None and flash_file.exists() else None)
        self.reboots = 0

        self.store = Store(Engine())
        self.module = Module.from_file(self.store.engine, str(path))
        self.boot()

    def boot(self):
        """Instantiate the module: once at the start and once per reboot."""
        self.storage = None
        self.display = None
        self.instance = Instance(self.store, self.module, self._imports())
        self.ex = self.instance.exports(self.store)
        self.mem = self.ex["memory"]
        self.sp = self.ex["__stack_pointer"]

    def flash_image(self) -> bytes | None:
        if self.storage is None:
            return self.storage_image
        ptr, length = self.storage
        return self.mem.read(self.store, ptr, ptr + length)

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
            # Relative to now, as in core.mjs: the clamp is a delay, and
            # against the absolute deadline every alarm after 100 s of guest
            # time looked like one.
            self.alarm_is_clamp = deadline - self.now_ns >= CLAMP_NS
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
                self.raise_irq(IRQ_TIMER)

        def entropy_get(ptr, length):
            if self.true_random:
                data = os.urandom(length)
            else:
                data = bytes(self.next_random_byte() for _ in range(length))
            self.mem.write(self.store, data, ptr)

        def gpio_out(port, values):
            # Nothing here draws anything, so an output change is a trace
            # line. It still has to be implemented: the module imports it,
            # and this host refuses to load a module whose imports it does
            # not know.
            if self.trace_gpio:
                sys.stderr.write(f"[gpio] port{port} out=0x{values & 0xFFFFFFFF:x}\n")

        def gpio_in(port):
            # Pins idle high, which is what a pull-up gives them and what
            # gpio_emul starts from. Nothing moves them: this host has no
            # one to press a button.
            return 0xFFFFFFFF

        def fatal(reason, arg):
            sys.stderr.write(f"\n*** fatal: reason {reason} (arg {arg}) ***\n")
            self.done = True
            self.exit_code = 1
            self.suspend(idle=False, fatal=True)

        def storage_attach(ptr, length):
            self.storage = (ptr, length)
            img = self.storage_image
            if img is None:
                return
            if len(img) != length:
                sys.stderr.write(f"\n*** flash image is {len(img)} bytes and the flash "
                                 f"is {length}; starting erased ***\n")
                return
            self.mem.write(self.store, img, ptr)

        def reboot(kind):
            raise Reboot(f"reboot (type {kind})")

        # The display: nothing here draws, but the framebuffer is guest
        # memory, so --screenshot can still read it, and the two engines'
        # frames can be compared byte for byte.
        def display_attach(ptr, width, height, fmt):
            self.display = (ptr, width, height)

        def display_flush(x, y, w, h):
            pass

        def display_blank(on):
            pass

        # Nothing here types or touches, so there is never an event.
        def input_poll(ptr):
            return 0

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
            "entropy_get": (entropy_get, [I32, I32], []),
            "gpio_out": (gpio_out, [I32, I32], []),
            "gpio_in": (gpio_in, [I32], [I32]),
            "safepoint_tick": (safepoint_tick, [], []),
            "fatal": (fatal, [I32, I32], []),
            "uart_poll_out": (uart_poll_out, [I32], []),
            "uart_poll_in": (uart_poll_in, [], [I32]),
            "storage_attach": (storage_attach, [I32, I32], []),
            "reboot": (reboot, [I32], []),
            "display_attach": (display_attach, [I32, I32, I32, I32], []),
            "display_flush": (display_flush, [I32, I32, I32, I32], []),
            "display_blank": (display_blank, [I32], []),
            "input_poll": (input_poll, [I32], [I32]),
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
        self.raise_irq(IRQ_TIMER)
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

    def next_random_byte(self) -> int:
        """xorshift32, the same one host/core.mjs uses."""
        x = self.rand_state
        x ^= (x << 13) & 0xFFFFFFFF
        x ^= x >> 17
        x ^= (x << 5) & 0xFFFFFFFF
        self.rand_state = x & 0xFFFFFFFF
        return self.rand_state & 0xFF

    def check_deadline(self):
        if self.now_ns > self.max_time_ns:
            raise GaveUp(f"gave up after {self.max_time_ns // 1_000_000} ms of guest time")

    def enter_boot(self):
        self.block_addr = self.call("z_wasm_switch_block_addr")
        self.irq_addr = self.call("z_wasm_irq_pending_addr")
        self.scratch = self.call("z_wasm_boot_scratch_addr")
        self.current = {"entry": "z_wasm_boot", "arg": 0, "buf": self.scratch,
                        "sp": None, "fresh": True}

    def reset_for_reboot(self):
        """As resetForReboot() in host/core.mjs: uptime restarts, and the
        time already used comes off the allowance."""
        self.max_time_ns -= self.now_ns
        self.now_ns = 0
        self.alarm_ns = None
        self.alarm_is_clamp = False
        self.quiescent = 0
        self.contexts = {}
        self.resume_same = False
        self.unwound_into = None
        self.pending_fatal = False

    def screenshot(self, path: Path) -> bool:
        """The display's last frame as a binary PPM, as run.mjs --screenshot."""
        if self.display is None:
            return False
        ptr, width, height = self.display
        raw = self.mem.read(self.store, ptr, ptr + width * height * 2)
        rgb = bytearray()
        for i in range(0, len(raw), 2):
            v = raw[i] | (raw[i + 1] << 8)
            r, g, b = (v >> 11) & 0x1F, (v >> 5) & 0x3F, v & 0x1F
            rgb += bytes(((r << 3) | (r >> 2), (g << 2) | (g >> 4), (b << 3) | (b >> 2)))
        path.write_bytes(f"P6\n{width} {height}\n255\n".encode() + bytes(rgb))
        return True

    def save_flash(self):
        image = self.flash_image()
        if self.flash_file is not None and image is not None:
            self.flash_file.write_bytes(bytes(image))

    def run(self) -> int:
        self.enter_boot()
        code = None
        while not self.done:
            try:
                self.check_deadline()
                if not self.step():
                    break
            except Reboot:
                self.storage_image = bytes(self.flash_image() or b"") or None
                self.save_flash()
                self.reboots += 1
                if self.reboots > MAX_REBOOTS:
                    sys.stderr.write(f"\n*** gave up after {MAX_REBOOTS} reboots ***\n")
                    code = 2
                    break
                self.reset_for_reboot()
                self.boot()
                self.enter_boot()
            except GaveUp as gave_up:
                sys.stderr.write(f"\n*** {gave_up} ***\n")
                code = 2
                break
        self.save_flash()
        return self.exit_code if code is None else code


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("wasm", type=Path)
    ap.add_argument("--max-time", type=int, default=10_000, help="guest time limit in ms")
    ap.add_argument("--seed", type=int, default=None,
                    help="seed the entropy generator")
    ap.add_argument("--true-random", action="store_true",
                    help="take entropy from the platform, ending reproducibility")
    ap.add_argument("--trace-gpio", action="store_true",
                    help="log every GPIO output change to stderr")
    ap.add_argument("--flash", type=Path, default=None,
                    help="keep the simulated flash in this file, as run.mjs --flash does")
    ap.add_argument("--screenshot", type=Path, default=None,
                    help="write the display's last frame as a binary PPM")
    args = ap.parse_args()
    host = Host(args.wasm, args.max_time, args.trace_gpio,
                args.seed, args.true_random, args.flash)
    code = host.run()
    if args.screenshot is not None and not host.screenshot(args.screenshot):
        sys.stderr.write("--screenshot: this build has no display\n")
        code = code or 1
    return code


if __name__ == "__main__":
    raise SystemExit(main())
