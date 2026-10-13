/* A real Bluetooth controller at the far end of a board's HCI UART.
 *
 * A board with the wasm-bt snippet runs Zephyr's own Bluetooth host on its
 * second UART, through upstream's H4 driver. Usually the other end is the
 * controller host/bt.mjs emulates. This is the other choice: a real one on
 * a serial port, such as an nRF54L15-DK running upstream's
 * samples/bluetooth/hci_uart. The page reaches it through Web Serial, run.mjs
 * through a tty; either hands this the bytes the device sends and takes the
 * bytes the board writes. Nothing here understands HCI: it is a wire
 * (DESIGN.md D8p).
 *
 * It offers core.mjs what BtController does for port 1. Bytes towards the
 * guest come down at the UART's line rate, as the console's do (D10), from
 * the moment they arrived. Bytes from the guest are batched and handed on
 * when the run loop next yields, which is when a guest waiting for an answer
 * is anyway.
 *
 * A real controller answers in real time, so a board with one follows the
 * wall clock while it waits (core.mjs), and nothing about such a run repeats.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

import { HCI_BYTE_NS } from './bt.mjs';

export class SerialHci {
  /**
   * @param write  takes a Uint8Array for the device; may be called often
   */
  constructor(write) {
    this.write = write;
    this.out = [];
    this.flushQueued = false;
    this.s = { rx: [], rxTaken: 0, rxRaisedAt: 0, rxReadyNs: 0n, airSent: 0, airReceived: 0 };
  }

  snapshot() { return structuredClone(this.s); }
  restore(s) { this.s = structuredClone(s); }

  /* ---- From the guest ------------------------------------------------- */

  fromHost(byte) {
    this.out.push(byte);
    this.s.airSent++;
    if (!this.flushQueued) {
      this.flushQueued = true;
      queueMicrotask(() => this.flush());
    }
  }

  flush() {
    this.flushQueued = false;
    if (this.out.length === 0) return;
    const bytes = Uint8Array.from(this.out);
    this.out = [];
    this.write(bytes);
  }

  /* ---- From the device ------------------------------------------------ */

  deliver(bytes) {
    for (const b of bytes) this.s.rx.push(b);
    this.s.airReceived += bytes.length;
  }

  rxReady(nowNs) {
    return this.s.rx.length > 0 && nowNs >= this.s.rxReadyNs;
  }

  rxTake(nowNs) {
    if (!this.rxReady(nowNs)) return -1;
    this.s.rxTaken++;
    this.s.rxReadyNs = nowNs + HCI_BYTE_NS;
    return this.s.rx.shift();
  }

  /* ---- Time ----------------------------------------------------------- */

  /* Only the next byte's time on the wire: what the device does next is
   * up to the device. */
  nextNs(nowNs) {
    return this.s.rx.length > 0 && this.s.rxReadyNs > nowNs ? this.s.rxReadyNs : null;
  }

  advance() {}
}
