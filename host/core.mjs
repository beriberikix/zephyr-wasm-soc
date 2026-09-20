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
 *   wait(ms)                    -> Promise                 pacing, if used
 *   gpioOut(port, values, ns)                              optional
 *
 * host/run.mjs supplies a Node one and host/web/worker.js a browser one. The
 * wasmtime host in host/run_wasmtime.py is a separate implementation in
 * Python, deliberately not sharing this file, so that it is an independent
 * check rather than the same code twice.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

import { IRQ } from './irq_lines.mjs';

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

/* The default entropy seed. Any fixed value would do; this one is only
 * memorable. Both hosts use the same generator and the same seed, so a build
 * that prints random numbers prints the same ones under Node and under
 * wasmtime, which the two-engine check depends on. */
const DEFAULT_SEED = 0x5eed0001;

/* The most virtual time that pacing will sit through in one go.
 *
 * Under virtual time the kernel clamps "nothing soon" to a deadline about two
 * days out, and jumping to it is how a run reaches its quiet end. Sleeping
 * two days of wall clock to match would not be pacing, it would be a hang, so
 * an advance longer than this is taken as fast as ever. Five seconds is
 * longer than anything a person is watching for and far shorter than the
 * clamp. */
const PACE_MAX_NS = 5_000_000_000n;

/* Virtual time charged per safepoint progress report. With the default of
 * 20000 safepoints between reports this makes a spinning thread advance the
 * clock at a plausible rate rather than a meaningful one; what matters is
 * that it advances at all, so deadlines can expire. */
const SAFEPOINT_TICK_NS = 100_000n;

/* struct wasm_thread_info: nine 32-bit fields, in the order the header
 * declares them. The guest fills it; the host only reads it, and learns no
 * Zephyr struct offsets in the process. */
const THREAD_INFO_WORDS = 9;
const THREAD_INFO_MAX = 24;

/* _THREAD_* in kernel_structs.h, lowest bit first. A thread with no bits set
 * is runnable. */
const THREAD_STATE_BITS = [
  'dummy', 'pending', 'sleeping', 'dead',
  'suspended', 'aborting', 'suspending', 'queued',
];

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
    /* Physical pin levels, per port. Outputs are what the guest last drove;
     * inputs are what the host is holding the pins at. A button wired active
     * low with a pull-up sits at 1 until something presses it, which is the
     * level gpio_emul gives it at boot, and the two have to agree because the
     * bridge forwards changes only. */
    this.gpio = [{ out: 0, in: opts.gpioInputs ?? 0xffffffff }];
    /* Interrupt lines raised from outside the driver loop. Applied at the top
     * of the loop rather than written straight into guest memory, because a
     * message handler can run before the module is even instantiated. */
    this.externalIrqs = 0;
    /* xorshift32, seeded. Not a good generator and not meant to be one: it
     * has to be cheap, identical in both hosts, and repeatable, because CI
     * requires two runs of a build to be byte-identical. --true-random opts
     * out for anyone who wants the platform's own randomness. */
    this.randState = (opts.seed ?? DEFAULT_SEED) >>> 0 || DEFAULT_SEED;
    /* Stepping. A step is one suspension: the guest runs until it switches
     * threads or idles, which is the granularity the driver loop already
     * works in and so costs nothing to offer. Finer than that would mean
     * suspending at every safepoint, which is a full unwind per loop
     * iteration. */
    this.paused = !!opts.paused;
    this.stepsLeft = 0;
    /* Bounded: each entry is a copy of linear memory, and nobody steps back
     * further than this by hand. */
    this.history = [];
    this.historyMax = opts.historyMax ?? 64;
  }

  /* Snapshot and restore, which is what makes stepping backwards possible.
   *
   * The whole machine is one linear memory plus a couple of globals, so a
   * snapshot is a copy and a restore is a write. That is the part the issue
   * is right to call out: on hardware this is a research project, and here
   * it is a memcpy of 128 KB.
   *
   * What is not in that buffer is the host's own bookkeeping -- the virtual
   * clock, the alarm, which context is current and where each one's stack
   * and Asyncify buffer are -- so that has to be copied alongside, and the
   * context map has to be rebuilt rather than shared, or restoring would
   * hand back objects the run has since mutated.
   *
   * Only taken while paused. Doing it on every suspension would mean
   * thousands of copies a second to no purpose.
   */
  snapshot() {
    const contexts = new Map();
    let current = null;
    for (const [buf, c] of this.contexts) {
      const copy = { ...c };
      contexts.set(buf, copy);
      if (c === this.current) current = copy;
    }
    if (current === null) current = { ...this.current };

    return {
      mem: new Uint8Array(this.mem.buffer.slice(0)),
      sp: this.ex.__stack_pointer.value,
      nowNs: this.nowNs,
      alarmNs: this.alarmNs,
      alarmIsClamp: this.alarmIsClamp,
      quiescentRounds: this.quiescentRounds,
      switches: this.switches,
      exitCode: this.exitCode,
      randState: this.randState,
      externalIrqs: this.externalIrqs,
      input: this.input.slice(),
      gpio: this.gpio.map((g) => ({ ...g })),
      contexts,
      current,
      resumeSame: this.resumeSame,
      currentSp: this.currentSp,
      unwoundInto: this.unwoundInto,
    };
  }

  restore(snap) {
    new Uint8Array(this.mem.buffer).set(snap.mem);
    this.ex.__stack_pointer.value = snap.sp;
    this.nowNs = snap.nowNs;
    this.alarmNs = snap.alarmNs;
    this.alarmIsClamp = snap.alarmIsClamp;
    this.quiescentRounds = snap.quiescentRounds;
    this.switches = snap.switches;
    this.exitCode = snap.exitCode;
    this.randState = snap.randState;
    this.externalIrqs = snap.externalIrqs;
    this.input = snap.input.slice();
    this.gpio = snap.gpio.map((g) => ({ ...g }));
    this.contexts = new Map();
    let current = null;
    for (const [buf, c] of snap.contexts) {
      const copy = { ...c };
      this.contexts.set(buf, copy);
      if (c === snap.current) current = copy;
    }
    this.current = current ?? { ...snap.current };
    this.resumeSame = snap.resumeSame;
    this.currentSp = snap.currentSp;
    this.unwoundInto = snap.unwoundInto;
  }

  /* One step back, if there is one. Returns whether anything happened. */
  stepBack() {
    const snap = this.history.pop();
    if (!snap) return false;
    this.restore(snap);
    this.paused = true;
    return true;
  }

  pause() { this.paused = true; }

  resume() { this.paused = false; }

  /* Let the guest run to its next suspension, then stop again. */
  stepOnce(n = 1) { this.stepsLeft += n; this.paused = true; }

  nextRandomByte() {
    let x = this.randState;
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;  x >>>= 0;
    this.randState = x;
    return x & 0xff;
  }

  /* Raise an interrupt from outside the driver loop. Safe to call from a
   * message handler or an input callback at any time. */
  injectIrq(line) {
    this.externalIrqs |= 1 << line;
  }

  /* Move an input pin and tell the guest. The level is physical: 0 is a
   * pressed active-low button. */
  setGpioInput(port, pin, level) {
    const state = this.gpio[port];
    if (!state) return;
    const bit = 1 << pin;
    const next = level ? (state.in | bit) : (state.in & ~bit);
    if (next === state.in) return;
    state.in = next >>> 0;
    this.injectIrq(IRQ.GPIO);
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

        entropy_get(ptr, len) {
          const bytes = new Uint8Array(self.mem.buffer, ptr, len);
          if (self.opts.trueRandom && globalThis.crypto?.getRandomValues) {
            /* getRandomValues refuses more than 65536 bytes at a time. */
            for (let off = 0; off < len; off += 65536) {
              globalThis.crypto.getRandomValues(bytes.subarray(off, Math.min(off + 65536, len)));
            }
            return;
          }
          for (let i = 0; i < len; i++) bytes[i] = self.nextRandomByte();
        },

        gpio_out(port, values) {
          const state = self.gpio[port];
          if (!state) return;
          state.out = values >>> 0;
          if (self.opts.traceGpio) {
            self.platform.writeErr(
              `[gpio] port${port} out=0x${state.out.toString(16)} at ${self.timeNs / 1_000_000n} ms\n`);
          }
          self.platform.gpioOut?.(port, state.out, self.timeNs);
        },

        gpio_in(port) {
          return self.gpio[port] ? self.gpio[port].in : 0xffffffff;
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
            self.raiseIrq(IRQ.TIMER);
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

  /* What threads does the kernel have, and which one holds the CPU?
   *
   * Only safe between steps, which is where run() calls it: the guest is
   * fully unwound, Asyncify is NORMAL, and nothing is mid-switch. The walk
   * runs on a stack of its own so it does not spend the headroom of whatever
   * thread happens to be suspended, which means saving and restoring
   * __stack_pointer around the call.
   *
   * Returns null when the module was not built with CONFIG_WASM_INSPECT.
   */
  snapshotThreads() {
    if (typeof this.ex.z_wasm_inspect_threads !== 'function') return null;
    if (this.infoAddr === undefined) {
      /* Borrow the top of the inspect stack for the records themselves: it
       * is the one region known to belong to nothing else. */
      const top = this.ex.z_wasm_inspect_stack_top();
      this.infoAddr = (top - THREAD_INFO_MAX * THREAD_INFO_WORDS * 4) & ~15;
    }

    const savedSp = this.ex.__stack_pointer.value;
    let count;
    try {
      this.ex.__stack_pointer.value = this.infoAddr;
      count = this.ex.z_wasm_inspect_threads(this.infoAddr, THREAD_INFO_MAX);
    } finally {
      this.ex.__stack_pointer.value = savedSp;
    }

    const words = new Uint32Array(this.mem.buffer, this.infoAddr, count * THREAD_INFO_WORDS);
    const bytes = new Uint8Array(this.mem.buffer);
    const rows = [];
    for (let i = 0; i < count; i++) {
      const at = i * THREAD_INFO_WORDS;
      const state = words[at + 1];
      let name = '';
      let p = words[at + 3];
      if (p) {
        const start = p;
        while (bytes[p] !== 0 && p - start < 64) p++;
        name = new TextDecoder().decode(bytes.subarray(start, p));
      }
      rows.push({
        thread: words[at],
        state,
        states: THREAD_STATE_BITS.filter((_, b) => state & (1 << b)),
        current: words[at + 2] === 1,
        name,
        prio: new Int32Array(this.mem.buffer, this.infoAddr + (at + 4) * 4, 1)[0],
        stackBase: words[at + 5],
        stackSize: words[at + 6],
        sp: words[at + 7],
        asyncifyBuf: words[at + 8],
      });
    }
    return rows;
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
   * next deadline. With no deadline there is nothing left to wait for.
   *
   * A scripted GPIO event counts as a deadline too. That is what lets a
   * sample which waits for a button be run unattended and still produce the
   * same output every time: the press happens at a stated guest time rather
   * than whenever a person got round to it. */
  advanceToNextDeadline() {
    const event = this.opts.gpio?.[0];
    if (event && (this.alarmNs === null || event.atNs <= this.alarmNs)) {
      this.opts.gpio.shift();
      if (event.atNs > this.nowNs) this.nowNs = event.atNs;
      this.quiescentRounds = 0;
      this.setGpioInput(event.port, event.pin, event.level);
      return true;
    }
    if (this.alarmNs === null) return false;
    /* Waking from a clamped deadline having done nothing is the signal that
     * the kernel has run out of work. Waking from a real one is progress. */
    this.quiescentRounds = this.alarmIsClamp ? this.quiescentRounds + 1 : 0;
    if (this.quiescentRounds > QUIESCENT_ROUNDS) return false;
    if (this.alarmNs > this.nowNs) this.nowNs = this.alarmNs;
    this.alarmNs = null;
    this.raiseIrq(IRQ.TIMER);
    return true;
  }

  /* Tell the platform what the kernel looks like now, if it is listening.
   *
   * Throttled: a run switches threads thousands of times a second and a page
   * cannot draw that, nor does anyone want it to. Paused, it always reports,
   * because then every step is one the viewer asked for.
   */
  report() {
    if (!this.platform.onState) return;
    const nowMs = Number(this.timeNs / 1_000_000n);
    if (!this.paused && this.lastReportAt !== undefined &&
        Date.now() - this.lastReportAt < 100) {
      return;
    }
    this.lastReportAt = Date.now();
    this.platform.onState({
      threads: this.snapshotThreads(),
      nowMs,
      alarmMs: this.alarmNs === null ? null : Number(this.alarmNs / 1_000_000n),
      pending: new Uint32Array(this.mem.buffer, this.irqPendingAddr, 1)[0],
      switches: this.switches,
      paused: this.paused,
      canStepBack: this.history.length,
    });
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

    /* Pacing: make virtual time pass at something like the rate it claims.
     *
     * A sample that sleeps a second between blinks is correct under virtual
     * time and invisible, because the host jumps straight to each deadline
     * and the whole run is over before a person sees it. Pacing waits out
     * the difference afterwards: the guest has already done the work, and
     * the host sleeps to match before letting it do any more.
     *
     * Doing it after the fact rather than before is what keeps determinism.
     * The guest observes exactly the timestamps it observes under plain
     * virtual time -- the clock is still set to the deadline and never to
     * however long the host actually slept -- so pacing changes when a thing
     * is shown and never what it is. timeScale divides the wait: 10 is ten
     * times faster than real, 0.1 is slow motion.
     */
    const paced = this.opts.clock === 'paced';
    let pacedFrom = this.nowNs;

    while (!this.done) {
      /* Paused between steps, which is where the guest is unwound and the
       * kernel's state is consistent enough to be looked at. */
      while (this.paused && this.stepsLeft === 0 && !this.done) {
        this.report();
        await this.platform.wait(50);
      }
      if (this.done) break;
      if (this.stepsLeft > 0) {
        /* Remember where this step started from, so it can be undone. */
        this.history.push(this.snapshot());
        if (this.history.length > this.historyMax) this.history.shift();
        this.stepsLeft--;
      }

      try {
        this.checkDeadline();
        /* Anything raised from outside since the last step. The guest is
         * fully unwound here, so writing the pending word is safe. */
        if (this.externalIrqs !== 0) {
          for (let line = 0; line < 32; line++) {
            if (this.externalIrqs & (1 << line)) this.raiseIrq(line);
          }
          this.externalIrqs = 0;
        }
        if (!this.step()) break;
      } catch (err) {
        if (!(err instanceof GaveUp)) throw err;
        this.platform.writeErr(`\n*** ${err.message} ***\n`);
        this.exitCode = 2;
        break;
      }
      this.report();

      if (paced) {
        const advanced = this.nowNs - pacedFrom;
        pacedFrom = this.nowNs;
        if (advanced > 0n && advanced <= PACE_MAX_NS) {
          const ms = Number(advanced) / 1e6 / (this.opts.timeScale || 1);
          if (ms >= 1) {
            this.yieldToHost = false;
            await this.platform.wait(ms);
            continue;
          }
        }
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
      if (pending === 0 && this.externalIrqs === 0 && !this.advanceToNextDeadline()) {
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
