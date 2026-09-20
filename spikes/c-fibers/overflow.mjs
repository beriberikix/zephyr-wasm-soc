/* SPDX-License-Identifier: Apache-2.0 */
// What happens when a thread's Asyncify buffer is too small for its stack?
// This matters because the buffer is half of the thread stack object, so
// getting the split wrong has to fail in a way the port can reason about.
import fs from 'node:fs';
const path = process.argv[2] ?? 'fibers.async.wasm';
let ex, bufPtr = 0;
const m = await WebAssembly.instantiate(fs.readFileSync(path), {
  env: {
    host_yield() {
      if (ex.asyncify_get_state() === 2) { ex.asyncify_stop_rewind(); return; }
      ex.asyncify_start_unwind(bufPtr);
    },
    host_log() {},
  },
});
ex = m.instance.exports;
const mem = new Int32Array(ex.memory.buffer);
const base = ex.arena_base(), sb = ex.stack_bytes();
bufPtr = base + sb;
const TINY = 256;              // depth 32 needs 1112 bytes
mem[bufPtr >> 2] = bufPtr + 8;
mem[(bufPtr >> 2) + 1] = bufPtr + TINY;
ex.set_yield_depth(32);
ex.__stack_pointer.value = base + sb;
try {
  ex.thread_main(0);
  const wrote = mem[bufPtr >> 2] - (bufPtr + 8);
  const over = wrote - (TINY - 8);
  console.log(`  ${path}: no trap. Wrote ${wrote} bytes into a ${TINY - 8} byte buffer, ${over} bytes past the end.`);
} catch (e) {
  console.log(`  ${path}: ${e.constructor.name}: ${e.message}`);
}
