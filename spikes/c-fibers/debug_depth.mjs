import fs from 'node:fs';
let ex, bufPtr = 0;
const m = await WebAssembly.instantiate(fs.readFileSync('fibers.async.wasm'), {
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
const base = ex.arena_base(), slot = ex.slot_bytes(), sb = ex.stack_bytes();
bufPtr = base + sb;
for (const depth of [0, 4, 16, 64]) {
  mem[bufPtr >> 2] = bufPtr + 8;
  mem[(bufPtr >> 2) + 1] = base + slot;
  ex.set_yield_depth(depth);
  ex.__stack_pointer.value = base + sb;
  ex.thread_main(0);
  const state = ex.asyncify_get_state();
  const used = mem[bufPtr >> 2] - (bufPtr + 8);
  console.log(`  depth=${String(depth).padStart(3)} state=${state} bytes=${used}`);
  if (state === 1) ex.asyncify_stop_unwind();
}
