/*
 * The engine-neutral half of the host harness.
 *
 * The host plays the SoC. It supplies the zephyr_host imports, owns the clock,
 * raises interrupts, and drives the Asyncify loop that makes context switching
 * possible: a wasm module cannot switch its own stack, so every switch unwinds
 * to here and is rewound from here.
 *
 * By default the clock is virtual. Time does not pass while the kernel runs;
 * when the kernel idles, the host jumps straight to the next deadline. That is
 * what makes two runs byte-identical, and what makes a run reproducible across
 * engines as well as across machines.
 *
 * Nothing in this file knows what it is running on. Everything that does is
 * passed in as a `platform`:
 *
 *   loadModule(spec)            -> Promise<BufferSource>   the module bytes
 *   writeOut(Uint8Array)                                   guest output
 *   writeErr(string)                                       harness diagnostics
 *   nowNs()                     -> BigInt                  wall clock
 *   startInput(push, interrupt)                            optional
 *   stopInput()                                            optional
 *   yieldToEventLoop(hasInput)  -> Promise                 let the host breathe
 *
 * host/run.mjs supplies a Node one and host/web/worker.js a browser one. The
 * wasmtime host in host/run_wasmtime.py is a separate implementation in
 * Python, deliberately not sharing this file, so that it is an independent
 * check rather than the same code twice.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

const ASYNCIFY_NORMAL = 0, ASYNCIFY_UNWINDING = 1, ASYNCIFY_REWINDING = 2;

/* Thrown out of an import to stop a guest that will not stop by itself. See
 * checkDeadline(). */
class GaveUp extends Error {}

/* Anything at or beyond this is the kernel saying "nothing soon" rather than
 * naming a deadline it cares about. It clamps to roughly INT32_MAX ticks. */
const CLAMP_NS = 100_000_000_000n;

/* How many times in a row the kernel may wake from a clamped deadline, do
 * nothing and ask for another before the run is called finished. Two is
 * enough to distinguish "still working" from "quiescent" and cheap, because
 * each round costs one suspension, not one tick. */
const QUIESCENT_ROUNDS = 2;

/* Virtual time charged per safepoint progress report. With the default of
 * 20000 safepoints between reports this makes a spinning thread advance the
 * clock at a plausible rate rather than a meaningful one; what matters is
 * that it advances at all, so deadlines can expire. */
const SAFEPOINT_TICK_NS = 100_000n;

/* Must match arch/wasm/core/fatal.c and Zephyr's k_fatal_error reasons. */
const FATAL_REASONS = [
  'CPU exception', 'spurious interrupt', 'stack overflow', 'kernel oops',
  'kernel panic',
];

export class Host {
  /**
   * @param platform  everything that is not wasm: see the list at the top.
   * @param opts      realtime, traceSwitches, maxTimeMs, interactive, wasm
   */
  constructor(platform, opts) {
    this.platform = platform;
    this.opts = opts;
    this.nowNs = 0n;             // virtual time; only advances when idle
    this.alarmNs = null;         // next timer deadline, or null for none
    this.startedAt = platform.nowNs();
    this.switches = 0;
    this.exitCode = 0;
    this.done = false;
    /* One entry per live context, keyed by its Asyncify buffer address.
     * Rewinding has to re-enter through the same export that first entered,
     * so the entry point and its argument are remembered here. */
    this.contexts = new Map();
    this.pending = null;         // the switch the guest just asked for
    this.resumeSame = false;     // set by an idle suspension
    this.alarmIsClamp = false;   // the last deadline was the kernel's clamp
    this.quiescentRounds = 0;
    this.input = [];             // bytes waiting for the guest's UART
  }

  get timeNs() {
    if (!this.opts.realtime) return this.nowNs;
    return this.platform.nowNs() - this.startedAt;
  }

  imports() {
    const self = this;
    return {
      zephyr_host: {
        console_write(ptr, len) {
          /* A copy, not a view: the platform may hand these bytes to
           * something that outlives this call, and the view is into live
           * guest memory. */
          self.platform.writeOut(new Uint8Array(self.mem.buffer, ptr, len).slice());
        },

        time_now_ns() { return self.timeNs; },

        uart_poll_out(c) {
          self.platform.writeOut(new Uint8Array([c & 0xff]));
        },

        uart_poll_in() {
          /* -1 means nothing waiting, which is what Zephyr's polled UART
           * API expects. */
          return self.input.length > 0 ? self.input.shift() : -1;
        },

        set_alarm_ns(deadline) {
          /* The kernel does not send a "never" sentinel; when it has no near
           * timeout it clamps to a deadline about two days out. Recording
           * that as "no alarm" is what ended runs early: the kernel idles
           * between being woken and programming its next real deadline, and
           * the host concluded nothing could ever happen again.
           *
           * So a clamp is kept as a real deadline and merely flagged. Time
           * still advances to it, the kernel still gets to reprogram, and
           * quiescence is decided by watching what it does next.
           */
          self.alarmIsClamp = deadline >= CLAMP_NS;
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

        safepoint_tick() {
          /* A spinning thread reports progress. Nothing in the guest can tell
           * us how long it took, so under virtual time we charge a fixed
           * amount per report: the guest is busy, and time should move. */
          if (!self.opts.realtime) {
            self.nowNs += SAFEPOINT_TICK_NS;
          }
          /* The only place a guest that never suspends can be stopped. */
          self.checkDeadline();
          if (self.alarmNs !== null && self.timeNs >= self.alarmNs) {
            self.alarmNs = null;
            self.quiescentRounds = 0;
            self.raiseIrq(0);
          }
        },

        fatal(reason, arg) {
          const name = FATAL_REASONS[reason] ?? `reason ${reason}`;
          self.platform.writeErr(`\n*** fatal: ${name} (arg ${arg}) ***\n`);
          self.done = true;
          self.exitCode = 1;
          self.suspend({ idle: false, fatal: true });
        },
      },
    };
  }

  /* An Asyncify buffer is two words -- a cursor and an end -- followed by
   * the saved frames. Binaryen does not bounds-check the cursor against the
   * end, and --asyncify-asserts does not add a check either, so a buffer
   * that is too small is written straight past and whatever follows it is
   * quietly corrupted. In spike C a 248-byte buffer absorbed 1112 bytes and
   * the run carried on.
   *
   * The host can see it for nothing, because both words are in linear
   * memory: after an unwind the cursor says how much was written. It is
   * still after the fact -- the bytes are already gone -- but a run that
   * says which thread overflowed its buffer and by how much is a different
   * thing to debug than one that produces the wrong answer later on. */
  bufferUse(buf) {
    const w = new Uint32Array(this.mem.buffer, buf, 2);
    const base = buf + 8;
    return { cursor: w[0], end: w[1], used: w[0] - base, limit: w[1] - base };
  }

  checkBuffer(buf, where) {
    const { cursor, end, used, limit } = this.bufferUse(buf);
    if (cursor >= buf + 8 && cursor <= end) return true;
    this.platform.writeErr(
      `\n*** asyncify buffer overflow ${where}: ` +
      `buffer 0x${buf.toString(16)} holds ${limit} bytes and the cursor is at ` +
      `${used}. Memory after the buffer has been overwritten.\n` +
      `*** Raise CONFIG_WASM_ASYNCIFY_BUFFER_SIZE, or give this thread a ` +
      `larger stack: the buffer is carved out of the thread's own stack ` +
      `object. ***\n`);
    this.done = true;
    this.exitCode = 1;
    return false;
  }

  /* Has this run gone on too long?
   *
   * The two limits below used to be checked between steps, which is no help
   * against the case they exist for: a guest that spins without suspending
   * never ends a step, so the loop never comes back round and the message
   * about a guest that ran without suspending could not be printed. A run in
   * that state hung for as long as anyone was willing to wait.
   *
   * So the check also runs from safepoint_tick, which a spinning guest calls
   * by construction. That import cannot suspend -- it is not in the Asyncify
   * import list, and adding it would mean paying a full unwind per loop
   * iteration -- so stopping the guest means throwing. The exception unwinds
   * the wasm frames to run(), which catches it. The instance is finished
   * either way; that is what giving up means.
   */
  checkDeadline() {
    if (this.timeNs > this.deadlineNs) {
      throw new GaveUp(`gave up after ${this.opts.maxTimeMs} ms of guest time`);
    }
    /* Virtual time only advances when the kernel idles or reports progress,
     * so bound the wall clock as well, generously. */
    if (Number(this.platform.nowNs() - this.startedAt) / 1e6 > this.opts.maxTimeMs * 3) {
      throw new GaveUp('gave up: the guest ran without suspending');
    }
    return true;
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
    /* Remember the buffer actually unwound into. The guest names the
     * outgoing thread's buffer in the switch block, and that is what must be
     * rewound later; keying the context by anything else would rewind from a
     * buffer the frames were never written to, which replays garbage call
     * indices and traps as a signature mismatch. */
    this.unwoundInto = fromBuf;
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
    /* Waking from a clamped deadline having done nothing is the signal that
     * the kernel has run out of work. Waking from a real one is progress. */
    this.quiescentRounds = this.alarmIsClamp ? this.quiescentRounds + 1 : 0;
    if (this.quiescentRounds > QUIESCENT_ROUNDS) return false;
    if (this.alarmNs > this.nowNs) this.nowNs = this.alarmNs;
    this.alarmNs = null;
    this.raiseIrq(0);               // line 0 is the system timer
    return true;
  }

  /* Input, if the platform offers any. Bytes arrive through the callback
   * and are served to the guest's UART by uart_poll_in. An interrupt key
   * belongs to the platform too, since the guest has no notion of one. */
  startInput() {
    if (!this.opts.interactive || !this.platform.startInput) {
      return;
    }
    this.platform.startInput(
      (byte) => this.input.push(byte),
      () => { this.done = true; });
  }

  stopInput() {
    if (this.opts.interactive && this.platform.stopInput) {
      this.platform.stopInput();
    }
  }

  async run() {
    const bytes = await this.platform.loadModule(this.opts.wasm);
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
    this.maskedAddr = this.ex.z_wasm_irq_masked_addr?.();
    this.enabledAddr = this.ex.z_wasm_irq_enabled_addr?.();

    /* The first context is the boot path itself. */
    this.current = { entry: 'z_wasm_boot', arg: 0, buf: this.scratchBuf, sp: null, fresh: true };
    this.startInput();

    this.deadlineNs = BigInt(this.opts.maxTimeMs) * 1_000_000n;
    while (!this.done) {
      try {
        this.checkDeadline();
        if (!this.step()) break;
      } catch (err) {
        if (!(err instanceof GaveUp)) throw err;
        this.platform.writeErr(`\n*** ${err.message} ***\n`);
        this.exitCode = 2;
        break;
      }
      if (this.yieldToHost) {
        /* The driver loop is synchronous, so Node's event loop never gets a
         * turn and typed characters would never arrive. Give it one whenever
         * the guest is idle, which is exactly when input can matter. */
        this.yieldToHost = false;
        await this.platform.yieldToEventLoop(this.input.length > 0);
      }
    }
    this.stopInput();
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
    const wasFresh = c.fresh;

    c.fresh = false;

    if (this.opts.traceSwitches) {
      const { used, limit } = this.bufferUse(c.buf);
      const sane = used >= 0 && used <= limit;
      this.platform.writeErr(
        `[enter] ${wasFresh ? 'fresh ' : 'REWIND'} ${c.entry}(0x${c.arg.toString(16)}) ` +
        `sp=0x${this.ex.__stack_pointer.value.toString(16)} ` +
        `buf=0x${c.buf.toString(16)} cursor=+${used} limit=${limit}` +
        `${sane ? '' : '  <-- CURSOR OUT OF RANGE'}\n`);
    }
    this.ex[c.entry](c.arg);

    if (this.ex.asyncify_get_state() !== ASYNCIFY_UNWINDING) {
      /* The context ran to completion rather than suspending. z_cstart never
       * returns, so this means the guest is finished. */
      return false;
    }
    this.ex.asyncify_stop_unwind();

    if (this.pendingFatal) return false;

    /* The frames have just been written, so this is where an overflow shows. */
    if (this.unwoundInto !== undefined && !this.checkBuffer(this.unwoundInto, 'on suspend')) {
      return false;
    }

    c.sp = this.currentSp;
    if (this.unwoundInto !== undefined && this.unwoundInto !== c.buf) {
      if (this.opts.traceSwitches) {
        this.platform.writeErr(`[fixup] context buf 0x${c.buf.toString(16)} ` +
          `unwound into 0x${this.unwoundInto.toString(16)}\n`);
      }
      c.buf = this.unwoundInto;
    }
    this.contexts.set(c.buf, c);

    if (this.resumeSame) {
      if (this.opts.traceSwitches && this.maskedAddr) {
        const w = new Uint32Array(this.mem.buffer);
        this.platform.writeErr(`[idle] pending=0x${w[this.irqPendingAddr >> 2].toString(16)} ` +
          `masked=${w[this.maskedAddr >> 2]} enabled=0x${w[this.enabledAddr >> 2].toString(16)} ` +
          `alarm=${this.alarmNs} now=${this.nowNs}` + '\n');
      }
      /* Idle: the same context resumes once something is pending. */
      const pending = new Uint32Array(this.mem.buffer, this.irqPendingAddr, 1)[0];
      if (this.opts.interactive) {
        /* Let input arrive before deciding there is nothing to do. */
        this.yieldToHost = true;
        if (pending === 0) {
          this.advanceToNextDeadline();
        }
        return true;
      }
      if (pending === 0 && !this.advanceToNextDeadline()) {
        /* Every thread is idle and no timer is armed, so nothing can ever
         * happen again. For a sample that has finished its work that is the
         * normal end of the run, not a failure. */
        if (this.opts.traceSwitches) {
          this.platform.writeErr('[idle] nothing left to wake the kernel; stopping\n');
        }
        return false;
      }
      return true;
    }

    /* A switch: move to the context the guest named. */
    const blk = this.readSwitchBlock();
    this.switches++;
    if (this.opts.traceSwitches) {
      this.platform.writeErr(`[switch #${this.switches}] -> buf=0x${blk.toBuf.toString(16)} ` +
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
