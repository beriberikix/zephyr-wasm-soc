#!/usr/bin/env node
/*
 * Host harness for the wasm Zephyr port.
 *
 * The host plays the SoC. It supplies the zephyr_host imports, owns the clock,
 * raises interrupts, and drives the Asyncify loop that makes context switching
 * possible: a wasm module cannot switch its own stack, so every switch unwinds
 * to here and is rewound from here.
 *
 * By default the clock is virtual. Time does not pass while the kernel runs;
 * when the kernel idles, the host jumps straight to the next deadline. That is
 * what makes two runs byte-identical. --realtime opts out.
 *
 * SPDX-License-Identifier: Apache-2.0
 */
import fs from 'node:fs';
import process from 'node:process';

const ASYNCIFY_NORMAL = 0, ASYNCIFY_UNWINDING = 1, ASYNCIFY_REWINDING = 2;

/* Must match arch/wasm/core/fatal.c and Zephyr's k_fatal_error reasons. */
const FATAL_REASONS = [
  'CPU exception', 'spurious interrupt', 'stack overflow', 'kernel oops',
  'kernel panic',
];

function parseArgs(argv) {
  const opts = { realtime: false, traceSwitches: false, maxTimeMs: 10_000, wasm: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--realtime') opts.realtime = true;
    else if (a === '--trace-switches') opts.traceSwitches = true;
    else if (a === '--max-time') opts.maxTimeMs = Number(argv[++i]);
    else if (a.startsWith('--max-time=')) opts.maxTimeMs = Number(a.slice(11));
    else if (a === '--help' || a === '-h') { usage(); process.exit(0); }
    else if (!a.startsWith('-')) opts.wasm = a;
    else { console.error(`unknown option ${a}`); usage(); process.exit(2); }
  }
  if (!opts.wasm) { usage(); process.exit(2); }
  return opts;
}

function usage() {
  console.error(`usage: run.mjs [options] <zephyr.wasm>

  --realtime         follow the wall clock instead of virtual time
  --trace-switches   log every context switch to stderr
  --max-time <ms>    give up after this much guest time (default 10000)`);
}

class Host {
  constructor(opts) {
    this.opts = opts;
    this.nowNs = 0n;             // virtual time; only advances when idle
    this.alarmNs = null;         // next timer deadline, or null for none
    this.startedAt = process.hrtime.bigint();
    this.switches = 0;
    this.exitCode = 0;
    this.done = false;
    /* One entry per live context, keyed by its Asyncify buffer address.
     * Rewinding has to re-enter through the same export that first entered,
     * so the entry point and its argument are remembered here. */
    this.contexts = new Map();
    this.pending = null;         // the switch the guest just asked for
    this.resumeSame = false;     // set by an idle suspension
  }

  get timeNs() {
    if (!this.opts.realtime) return this.nowNs;
    return process.hrtime.bigint() - this.startedAt;
  }

  imports() {
    const self = this;
    return {
      zephyr_host: {
        console_write(ptr, len) {
          const bytes = new Uint8Array(self.mem.buffer, ptr, len);
          process.stdout.write(Buffer.from(bytes));
        },

        time_now_ns() { return self.timeNs; },

        set_alarm_ns(deadline) {
          /* INT64_MAX means "nothing to wake for". */
          self.alarmNs = deadline >= 0x7fffffffffffffffn ? null : deadline;
        },

        wait_for_event() {
          if (self.ex.asyncify_get_state() === ASYNCIFY_REWINDING) {
            self.ex.asyncify_stop_rewind();
            return;
          }
          self.suspend({ idle: true });
        },

        switch_to() {
          if (self.ex.asyncify_get_state() === ASYNCIFY_REWINDING) {
            self.ex.asyncify_stop_rewind();
            return;
          }
          self.suspend({ idle: false });
        },

        fatal(reason, arg) {
          const name = FATAL_REASONS[reason] ?? `reason ${reason}`;
          process.stderr.write(`\n*** fatal: ${name} (arg ${arg}) ***\n`);
          self.done = true;
          self.exitCode = 1;
          self.suspend({ idle: false, fatal: true });
        },
      },
    };
  }

  /* Begin unwinding out of the guest. Both suspension points land here. */
  suspend({ idle, fatal = false }) {
    const blk = this.readSwitchBlock();
    /* The dummy thread at boot has no buffer of its own; it is never resumed,
     * so its frames go to the scratch buffer and are discarded. */
    const fromBuf = idle || fatal ? this.current.buf : (blk.fromBuf || this.scratchBuf);
    this.currentSp = this.ex.__stack_pointer.value;
    this.resumeSame = idle;
    this.pendingFatal = fatal;
    this.ex.asyncify_start_unwind(fromBuf);
  }

  readSwitchBlock() {
    const w = new Uint32Array(this.mem.buffer, this.switchBlockAddr, 6);
    return { fromSp: w[0], fromBuf: w[1], toSp: w[2], toBuf: w[3], toFresh: w[4], toArg: w[5] };
  }

  raiseIrq(line) {
    const w = new Uint32Array(this.mem.buffer, this.irqPendingAddr, 1);
    w[0] |= (1 << line);
  }

  /* Virtual time: nothing happens until the kernel idles, then jump to the
   * next deadline. With no deadline there is nothing left to wait for. */
  advanceToNextDeadline() {
    if (this.alarmNs === null) return false;
    if (this.alarmNs > this.nowNs) this.nowNs = this.alarmNs;
    this.alarmNs = null;
    this.raiseIrq(0);               // line 0 is the system timer
    return true;
  }

  async run() {
    const bytes = fs.readFileSync(this.opts.wasm);
    const { instance } = await WebAssembly.instantiate(bytes, this.imports());
    this.ex = instance.exports;
    this.mem = this.ex.memory;

    for (const name of ['z_wasm_boot', 'z_wasm_switch_block_addr',
                        'z_wasm_irq_pending_addr', 'z_wasm_thread_entry',
                        'z_wasm_boot_scratch_addr', 'asyncify_start_unwind']) {
      if (typeof this.ex[name] !== 'function') {
        throw new Error(`module is missing export ${name}; was it built for this board and run through wasm-opt --asyncify?`);
      }
    }

    this.switchBlockAddr = this.ex.z_wasm_switch_block_addr();
    this.irqPendingAddr = this.ex.z_wasm_irq_pending_addr();
    this.scratchBuf = this.ex.z_wasm_boot_scratch_addr();

    /* The first context is the boot path itself. */
    this.current = { entry: 'z_wasm_boot', arg: 0, buf: this.scratchBuf, sp: null, fresh: true };

    const deadlineNs = BigInt(this.opts.maxTimeMs) * 1_000_000n;
    while (!this.done) {
      if (this.timeNs > deadlineNs) {
        process.stderr.write(`\n*** gave up after ${this.opts.maxTimeMs} ms of guest time ***\n`);
        this.exitCode = 2;
        break;
      }
      /* Virtual time only advances when the kernel idles, so a guest that
       * spins without ever suspending would never trip the guest-time check.
       * Bound the wall clock as well, generously, so a hang is reported
       * rather than sat through. */
      if (Number(process.hrtime.bigint() - this.startedAt) / 1e6 > this.opts.maxTimeMs * 3) {
        process.stderr.write('\n*** gave up: the guest ran without suspending ***\n');
        this.exitCode = 2;
        break;
      }
      if (!this.step()) break;
    }
    return this.exitCode;
  }

  /* Run the current context until it suspends, then pick the next one. */
  step() {
    const c = this.current;
    if (!c.fresh) {
      this.ex.__stack_pointer.value = c.sp;
      this.ex.asyncify_start_rewind(c.buf);
    } else if (c.sp !== null) {
      this.ex.__stack_pointer.value = c.sp;
    }
    c.fresh = false;

    if (this.opts.traceSwitches) {
      process.stderr.write(`[enter] ${c.entry}(0x${c.arg.toString(16)}) sp=0x${(this.ex.__stack_pointer.value).toString(16)}\n`);
    }
    this.ex[c.entry](c.arg);

    if (this.ex.asyncify_get_state() !== ASYNCIFY_UNWINDING) {
      /* The context ran to completion rather than suspending. z_cstart never
       * returns, so this means the guest is finished. */
      return false;
    }
    this.ex.asyncify_stop_unwind();

    if (this.pendingFatal) return false;

    c.sp = this.currentSp;
    this.contexts.set(c.buf, c);

    if (this.resumeSame) {
      /* Idle: the same context resumes once something is pending. */
      const pending = new Uint32Array(this.mem.buffer, this.irqPendingAddr, 1)[0];
      if (pending === 0 && !this.advanceToNextDeadline()) {
        process.stderr.write('\n*** kernel idled with nothing left to wake it ***\n');
        return false;
      }
      return true;
    }

    /* A switch: move to the context the guest named. */
    const blk = this.readSwitchBlock();
    this.switches++;
    if (this.opts.traceSwitches) {
      process.stderr.write(`[switch #${this.switches}] -> buf=0x${blk.toBuf.toString(16)} ` +
                           `sp=0x${blk.toSp.toString(16)} ${blk.toFresh ? 'fresh' : 'resume'}\n`);
    }

    if (blk.toFresh) {
      this.current = { entry: 'z_wasm_thread_entry', arg: blk.toArg, buf: blk.toBuf,
                       sp: blk.toSp, fresh: true };
    } else {
      const known = this.contexts.get(blk.toBuf);
      if (!known) throw new Error(`asked to resume unknown context buf=0x${blk.toBuf.toString(16)}`);
      /* Deliberately keep the stack pointer the host saved when this context
       * unwound. The guest's to_sp is only meaningful for a thread that has
       * never run; for a resume it still holds the value from thread
       * creation, and rewinding onto that would drop the whole stack. */
      this.current = known;
    }
    return true;
  }
}

const opts = parseArgs(process.argv.slice(2));
const host = new Host(opts);
process.exit(await host.run());
