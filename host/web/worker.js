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

  /* The kernel's state, as often as the core decides is worth sending. */
  onState(state) {
    self.postMessage({ type: 'state', state });
  },

  /* A reboot: the flash is about to carry over to a new instance, and the
   * page keeps a copy in case the tab goes before the next save. */
  flashChanged(image) {
    sendFlash(image);
  },
};

/* The simulated flash goes to the page to keep, in IndexedDB. Sent only when
 * it has changed, which for most builds is never, because most builds have
 * no flash at all. */
let lastFlash = null;

function sameBytes(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/* The display: a frame goes to the page when something was drawn, at most
 * once per timer tick, as RGBA the canvas can take as it is. Transferred,
 * not copied: the core already made a private copy of guest memory. */
function sendFrame() {
  if (!host?.displayDirty()) return;
  const frame = host.displayFrame();
  if (!frame) return;
  self.postMessage({ type: 'frame', width: frame.width, height: frame.height,
                     blank: frame.blank, frames: frame.frames, rgba: frame.rgba.buffer },
                   [frame.rgba.buffer]);
}

function sendFlash(image) {
  if (!image || sameBytes(image, lastFlash)) return;
  lastFlash = image;
  self.postMessage({ type: 'flash', image });
}

self.onmessage = async (event) => {
  const msg = event.data;

  if (msg.type === 'pause') { host?.pause(); return; }
  if (msg.type === 'resume') { host?.resume(); return; }
  if (msg.type === 'step') { host?.stepOnce(msg.count ?? 1); return; }
  if (msg.type === 'back') { host?.stepBack(); return; }

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

  if (msg.type === 'input-events') {
    /* Touch and keys from the page. Queued and applied at the top of the
     * driver loop, like a button press. */
    host?.pushInput(msg.events);
    return;
  }

  if (msg.type === 'input') {
    /* Every byte goes to the guest, Ctrl-C included: the page has a Stop
     * button, so Ctrl-C can be what it is on a board's serial console,
     * which the shell uses to abandon the line. Only run.mjs, in a terminal
     * with nothing else to stop it, takes Ctrl-C for itself. */
    for (const b of msg.bytes) {
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
    flashImage: msg.flashImage ?? null,
  };
  lastFlash = msg.flashImage ?? null;

  try {
    host = new Host(browserPlatform, opts);
    /* Stop has to reach a run that is already going, and the only safe moment
     * is between suspensions, which is where the core checks `done`. */
    /* The same timer saves the flash every couple of seconds. It only fires
     * while the driver loop is yielded, which is when the guest is unwound
     * and its memory can be read. */
    let ticks = 0;
    const tick = setInterval(() => {
      if (stopRequested) host.done = true;
      sendFrame();
      if (++ticks % 40 === 0 && host.storage) sendFlash(host.flashImage());
    }, 50);
    const code = await host.run();
    clearInterval(tick);
    if (host.storage) sendFlash(host.flashImage());
    sendFrame();
    host = null;
    self.postMessage({ type: 'done', code });
  } catch (err) {
    host = null;
    self.postMessage({ type: 'err', text: `\n*** harness error: ${err.message} ***\n` });
    self.postMessage({ type: 'done', code: 1 });
  }
};
