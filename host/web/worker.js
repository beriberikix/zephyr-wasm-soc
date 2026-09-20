/*
 * The browser front-end to the host harness.
 *
 * Runs in a Worker, because the guest blocks its thread between suspensions:
 * the driver loop only returns when the kernel idles or switches, and on the
 * page's thread that would freeze the tab. Output goes to the page by message,
 * and keystrokes come back the same way.
 *
 * There is no SharedArrayBuffer here and so no need for cross-origin isolation
 * headers. Input works because the driver loop already yields to the event
 * loop whenever the guest is idle, which is exactly when a queued message gets
 * delivered, and never on a hot path.
 *
 * SPDX-License-Identifier: Apache-2.0
 */
/* Flat in the staged site: scripts/stage_site.sh copies core.mjs next to
 * this file, so local and published layouts are the same thing. */
import { Host } from './core.mjs';

let pushInput = null;      // set by the core once a run starts
let interrupt = null;
let stopRequested = false;
let host = null;           // the running Host, so buttons can reach it

const browserPlatform = {
  async loadModule(url) {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`could not fetch ${url}: ${res.status} ${res.statusText}`);
    }
    /* Deliberately not instantiateStreaming: that insists on an
     * application/wasm content type, and a plain static server may not send
     * one. An ArrayBuffer sidesteps the question entirely. */
    return await res.arrayBuffer();
  },

  writeOut(bytes) {
    /* Transfer rather than copy; the core already handed over a private
     * copy of the guest's memory. */
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    self.postMessage({ type: 'out', buf }, [buf]);
  },

  writeErr(text) {
    self.postMessage({ type: 'err', text });
  },

  /* performance.now() is milliseconds as a float; the core wants nanoseconds
   * as a BigInt, and only ever uses it for elapsed wall time. */
  nowNs: () => BigInt(Math.round(performance.now() * 1e6)),

  startInput(push, onInterrupt) {
    pushInput = push;
    interrupt = onInterrupt;
  },

  stopInput() {
    pushInput = null;
    interrupt = null;
  },

  yieldToEventLoop: (hasInput) =>
    new Promise((resolve) => setTimeout(resolve, hasInput ? 0 : 1)),

  /* Used only for pacing. A macrotask, so queued messages -- a button press,
   * a change of speed -- are delivered while the host waits. */
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),

  /* An output pin moved. The page draws it. */
  gpioOut(port, values) {
    self.postMessage({ type: 'gpio', port, values });
  },
};

self.onmessage = async (event) => {
  const msg = event.data;

  if (msg.type === 'speed') {
    /* Applies to the next wait, which is at most a few hundred milliseconds
     * away, so the slider feels immediate without anything being
     * interrupted. */
    if (host) host.opts.timeScale = msg.timeScale;
    return;
  }

  if (msg.type === 'gpio-in') {
    /* Safe at any time: the host records the line and applies it at the top
     * of its loop, so nothing here writes guest memory. A message is only
     * delivered while the driver loop is yielded, which is when the guest is
     * idle and fully unwound. */
    host?.setGpioInput(msg.port ?? 0, msg.pin, msg.level);
    return;
  }

  if (msg.type === 'input') {
    for (const b of msg.bytes) {
      if (b === 3 && interrupt) {      // Ctrl-C
        interrupt();
        return;
      }
      if (pushInput) pushInput(b);
    }
    return;
  }

  if (msg.type === 'stop') {
    stopRequested = true;
    if (interrupt) interrupt();
    return;
  }

  if (msg.type !== 'run') return;

  stopRequested = false;
  const opts = {
    realtime: false,
    traceSwitches: false,
    maxTimeMs: msg.maxTimeMs ?? 10_000,
    interactive: !!msg.interactive,
    clock: msg.clock ?? 'virtual',
    timeScale: msg.timeScale ?? 1,
    wasm: msg.url,
  };

  try {
    host = new Host(browserPlatform, opts);
    /* Stop has to reach a run that is already going, and the only safe moment
     * is between suspensions, which is where the core checks `done`. */
    const tick = setInterval(() => { if (stopRequested) host.done = true; }, 50);
    const code = await host.run();
    clearInterval(tick);
    host = null;
    self.postMessage({ type: 'done', code });
  } catch (err) {
    host = null;
    self.postMessage({ type: 'err', text: `\n*** harness error: ${err.message} ***\n` });
    self.postMessage({ type: 'done', code: 1 });
  }
};
