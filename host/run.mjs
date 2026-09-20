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
                 interactive: false, wasm: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--realtime') opts.realtime = true;
    else if (a === '--trace-switches') opts.traceSwitches = true;
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

function usage() {
  console.error(`usage: run.mjs [options] <zephyr.wasm>

  --realtime         follow the wall clock instead of virtual time
  --trace-switches   log every context switch to stderr
  --max-time <ms>    give up after this much guest time (default 10000)
  --interactive      forward this terminal's input to the guest UART, and
                     do not stop when the guest has nothing left to do`);
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
