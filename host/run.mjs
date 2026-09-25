#!/usr/bin/env node
/*
 * The Node front-end to the host harness.
 *
 * Everything that is not specific to Node lives in core.mjs; this file is the
 * command line, and the handful of things only an operating system can do:
 * read a file, write to a terminal, read keystrokes, and tell the time.
 *
 * SPDX-License-Identifier: Apache-2.0
 */
import fs from 'node:fs';
import process from 'node:process';

import { Host } from './core.mjs';

function parseArgs(argv) {
  const opts = { realtime: false, traceSwitches: false, maxTimeMs: 10_000,
                 interactive: false, traceGpio: false, gpio: [],
                 clock: 'virtual', timeScale: 1,
                 seed: undefined, trueRandom: false, threads: false, wasm: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--realtime') opts.realtime = true;
    else if (a === '--paced') opts.clock = 'paced';
    else if (a === '--time-scale') opts.timeScale = Number(argv[++i]);
    else if (a === '--seed') opts.seed = Number(argv[++i]);
    else if (a === '--true-random') opts.trueRandom = true;
    else if (a === '--threads') opts.threads = true;
    else if (a === '--trace-switches') opts.traceSwitches = true;
    else if (a === '--trace-gpio') opts.traceGpio = true;
    else if (a === '--gpio') opts.gpio.push(parseGpioEvent(argv[++i]));
    else if (a === '--interactive') opts.interactive = true;
    else if (a === '--flash') opts.flashFile = argv[++i];
    else if (a === '--max-time') opts.maxTimeMs = Number(argv[++i]);
    else if (a.startsWith('--max-time=')) opts.maxTimeMs = Number(a.slice(11));
    else if (a === '--help' || a === '-h') { usage(); process.exit(0); }
    else if (!a.startsWith('-')) opts.wasm = a;
    else { console.error(`unknown option ${a}`); usage(); process.exit(2); }
  }
  if (!opts.wasm) { usage(); process.exit(2); }
  return opts;
}

/* --gpio <ms>:<pin>=<level>, repeatable. Scripted rather than interactive so
 * that a sample which waits for a button can be run unattended and still
 * produce the same output every time. */
function parseGpioEvent(spec) {
  const m = /^(\d+):(\d+)=([01])$/.exec(spec ?? '');
  if (!m) {
    console.error(`--gpio wants <ms>:<pin>=<0|1>, not ${JSON.stringify(spec)}`);
    process.exit(2);
  }
  return { atNs: BigInt(m[1]) * 1_000_000n, port: 0, pin: Number(m[2]), level: Number(m[3]) };
}

function usage() {
  console.error(`usage: run.mjs [options] <zephyr.wasm>

  --realtime         follow the wall clock instead of virtual time
  --trace-switches   log every context switch to stderr
  --max-time <ms>    give up after this much guest time (default 10000)
  --interactive      forward this terminal's input to the guest UART, and
                     do not stop when the guest has nothing left to do
  --paced            let virtual time pass at the rate it claims, so a
                     sample that blinks once a second can be watched. The
                     guest sees the same clock either way, so the output is
                     unchanged
  --time-scale <n>   with --paced, divide the waiting: 10 is ten times
                     faster than real, 0.1 is slow motion
  --seed <n>         seed the entropy generator, for a different but still
                     repeatable sequence
  --true-random      take entropy from the platform instead, which ends
                     reproducibility
  --threads          print the kernel's thread table to stderr as it changes
  --trace-gpio       log every GPIO output change to stderr
  --gpio <ms>:<pin>=<0|1>
                     move an input pin at a given guest time, repeatable.
                     Levels are physical, so a button wired active low is
                     pressed at 0 and released at 1.
  --flash <file>     keep the simulated flash in this file: loaded before
                     boot if it exists, written back on reboot and at the
                     end. Without it the flash starts erased every run`);
}

const nodePlatform = {
  loadModule: (path) => fs.readFileSync(path),
  writeOut: (bytes) => process.stdout.write(Buffer.from(bytes)),
  writeErr: (text) => process.stderr.write(text),
  nowNs: () => process.hrtime.bigint(),

  startInput(push, interrupt) {
    const stdin = process.stdin;
    if (stdin.isTTY) {
      /* Raw mode so the shell sees keystrokes as they are typed, including
       * control characters, rather than whole lines. */
      stdin.setRawMode(true);
    }
    stdin.on('data', (chunk) => {
      for (const b of chunk) {
        /* Ctrl-C has to be handled here: in raw mode the terminal will not
         * do it, and the guest has no notion of a signal. */
        if (b === 3) {
          interrupt();
          return;
        }
        push(b);
      }
    });
    stdin.resume();
  },

  stopInput() {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.stdin.pause();
    /* Let the process end with the listener still attached: without this a
     * run that read input would keep the event loop alive after the guest
     * had finished. */
    process.stdin.unref();
  },

  /* A macrotask, so anything queued on the event loop, typed characters in
   * particular, gets delivered before the guest runs again. */
  yieldToEventLoop: (hasInput) =>
    new Promise((resolve) => setTimeout(resolve, hasInput ? 0 : 1)),

  /* Used only for pacing. Also a macrotask, so input still arrives. */
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/* --threads prints the kernel's thread table to stderr whenever it changes
 * enough to be worth printing. stderr, so stdout stays the contract that
 * the determinism and two-engine checks compare. */
function threadTable(state) {
  if (!state.threads) {
    return '[threads] this build has no CONFIG_WASM_INSPECT\n';
  }
  const rows = state.threads.map((t) =>
    `  ${t.current ? '*' : ' '} ${(t.name || '(unnamed)').padEnd(18)} ` +
    `prio ${String(t.prio).padStart(3)}  ` +
    `${(t.states.join(',') || 'ready').padEnd(18)} ` +
    `sp 0x${t.sp.toString(16)}`);
  return `[threads] at ${state.nowMs} ms, ${state.switches} switches, ` +
         `pending 0x${state.pending.toString(16)}` +
         `${state.alarmMs === null ? '' : `, next deadline ${state.alarmMs} ms`}\n` +
         rows.join('\n') + '\n';
}

const opts = parseArgs(process.argv.slice(2));

/* Set the code and let Node exit on its own, rather than process.exit().
 *
 * Writes to stdout are synchronous when it is a terminal or a file and
 * asynchronous when it is a pipe, and process.exit() discards whatever is
 * still queued. So the output was complete when a person watched it or
 * redirected it to a file, and silently truncated whenever it was piped --
 * which is every run inside a shell substitution, a tee, or a checking
 * script. The guest was never at fault and the run had already finished.
 */
if (opts.threads) {
  let last = '';
  nodePlatform.onState = (state) => {
    const table = threadTable(state);
    if (table !== last) {
      last = table;
      process.stderr.write(table);
    }
  };
}

/* The simulated flash, kept in a file between runs and across reboots. */
if (opts.flashFile) {
  if (fs.existsSync(opts.flashFile)) {
    opts.flashImage = new Uint8Array(fs.readFileSync(opts.flashFile));
  }
  nodePlatform.flashChanged = (image) => {
    if (image) fs.writeFileSync(opts.flashFile, image);
  };
}

const host = new Host(nodePlatform, opts);
process.exitCode = await host.run();
if (opts.flashFile) nodePlatform.flashChanged(host.flashImage());
