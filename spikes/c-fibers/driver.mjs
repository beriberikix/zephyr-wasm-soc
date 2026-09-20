/* SPDX-License-Identifier: Apache-2.0 */
// Host-side driver for spike C: run several wasm "threads" round-robin by
// unwinding one Asyncify stack and rewinding another.
//
// Asyncify gives five controls: start_unwind, stop_unwind, start_rewind,
// stop_rewind and get_state (0 normal, 1 unwinding, 2 rewinding). The host
// swaps two things per switch: the Asyncify buffer, which holds the wasm
// frames, and __stack_pointer, which walks the C shadow stack in linear
// memory. Asyncify does not manage the second one, so the arch has to.
import fs from 'node:fs';

export const STATE_NORMAL = 0, STATE_UNWINDING = 1, STATE_REWINDING = 2;

export async function makeScheduler(wasmPath, { iterations, quiet = false, trace = false, yieldDepth = 0 }) {
  const log = [];
  let exports_;
  let current = null;
  let switches = 0;
  let peakBufferUse = 0;

  const imports = {
    env: {
      host_yield() {
        // Second entry, during a rewind: stop rewinding and let the thread run on.
        if (exports_.asyncify_get_state() === STATE_REWINDING) {
          exports_.asyncify_stop_rewind();
          return;
        }
        // First entry: save the shadow stack pointer, then unwind.
        current.sp = exports_.__stack_pointer.value;
        exports_.asyncify_start_unwind(current.asyncifyBuf);
      },
      host_log(id, iteration, checksum) {
        if (checksum === -1) throw new Error(`thread ${id} lost its locals at iteration ${iteration}`);
        if (iteration < iterations && !quiet) log.push(`t${id} i${iteration} ${checksum >>> 0}`);
        if (iteration >= iterations - 1) current.done = true;
      },
    },
  };

  const mod = await WebAssembly.instantiate(fs.readFileSync(wasmPath), imports);
  exports_ = mod.instance.exports;

  // Carve the arena the module exported into per-thread regions. The low part
  // of each slot is the shadow stack (it grows down, so the pointer starts at
  // the top), the high part is the Asyncify buffer.
  const base = exports_.arena_base();
  const slot = exports_.slot_bytes();
  const stackBytes = exports_.stack_bytes();
  const n = exports_.nthreads();
  const mem = new Int32Array(exports_.memory.buffer);
  if (exports_.set_yield_depth) exports_.set_yield_depth(yieldDepth);

  const threads = [];
  for (let i = 0; i < n; i++) {
    const slotBase = base + i * slot;
    const asyncifyBuf = slotBase + stackBytes;
    // Asyncify buffer header: [current, end]. Data starts after the header.
    mem[asyncifyBuf >> 2] = asyncifyBuf + 8;
    mem[(asyncifyBuf >> 2) + 1] = slotBase + slot;
    threads.push({ id: i, stackTop: slotBase + stackBytes, asyncifyBuf, sp: 0, started: false, done: false });
  }

  // Run one thread until it yields or finishes.
  function runSlice(t) {
    current = t;
    if (!t.started) {
      t.started = true;
      exports_.__stack_pointer.value = t.stackTop;
      exports_.thread_main(t.id);
    } else {
      exports_.__stack_pointer.value = t.sp;
      exports_.asyncify_start_rewind(t.asyncifyBuf);
      exports_.thread_main(t.id); // args ignored; the stack is replayed
    }
    if (exports_.asyncify_get_state() === STATE_UNWINDING) {
      // The buffer cursor has now advanced by exactly the bytes this unwind needed.
      const used = mem[t.asyncifyBuf >> 2] - (t.asyncifyBuf + 8);
      if (used > peakBufferUse) peakBufferUse = used;
      exports_.asyncify_stop_unwind();
    } else {
      t.done = true;
    }
  }

  function runAll() {
    let i = 0;
    for (;;) {
      const live = threads.filter((t) => !t.done);
      if (live.length === 0) break;
      const t = live[i++ % live.length];
      if (trace) console.error(`  switch -> t${t.id}`);
      runSlice(t);
      switches++;
    }
  }

  return { runAll, log, threads, get switches() { return switches; }, get peakBufferUse() { return peakBufferUse; } };
}
