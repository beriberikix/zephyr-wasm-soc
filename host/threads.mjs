/* What a thread is waiting for, in words.
 *
 * Shared by the page's thread table and run.mjs --threads, so both say the
 * same thing. It reads only what the guest put in struct wasm_thread_info
 * (Host.snapshotThreads() turns that into rows); the guest decides what a
 * wait queue belongs to, and the host only names the threads involved.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

const hex = (n) => `0x${n.toString(16)}`;

/* A row's name, or its address when it has none. */
export function threadName(row) {
  return row.name || `thread ${hex(row.thread)}`;
}

/* "" for a thread that is waiting for nothing, which is a ready or running
 * one: every wait the kernel has is a wait queue, a timeout, or both. A
 * timeout on a wait is when the thread gives up; on its own it is when the
 * thread wakes, which is what sleeping is. */
export function describeWait(row, rows) {
  const ms = row.timeoutMs;
  if (row.pendedOn) {
    let what = `kernel object ${hex(row.pendedOn)}`;
    if (row.heldBy) {
      const holder = rows.find((r) => r.thread === row.heldBy);
      const who = holder ? threadName(holder) : `thread ${hex(row.heldBy)}`;
      what = `mutex ${hex(row.pendedOn)} held by ${who}`;
    }
    return ms >= 0 ? `${what}, gives up in ${ms} ms` : what;
  }
  return ms >= 0 ? `wakes in ${ms} ms` : '';
}
