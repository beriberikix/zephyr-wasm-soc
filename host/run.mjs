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
                 seed: undefined, trueRandom: false, wasm: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--realtime') opts.realtime = true;
    else if (a === '--paced') opts.clock = 'paced';
    else if (a === '--time-scale') opts.timeScale = Number(argv[++i]);
    else if (a === '--seed') opts.seed = Number(argv[++i]);
    else if (a === '--true-random') opts.trueRandom = true;
    else if (a === '--trace-switches') opts.traceSwitches = true;
    else if (a === '--trace-gpio') opts.traceGpio = true;
    else if (a === '--gpio') opts.gpio.push(parseGpioEvent(argv[++i]));
    else if (a === '--interactive') opts.interactive = true;
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
  --trace-gpio       log every GPIO output change to stderr
  --gpio <ms>:<pin>=<0|1>
                     move an input pin at a given guest time, repeatable.
                     Levels are physical, so a button wired active low is
                     pressed at 0 and released at 1.`);
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
process.exitCode = await new Host(nodePlatform, opts).run();
