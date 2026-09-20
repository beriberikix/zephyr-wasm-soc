// A correctly instrumented module unwinds on the FIRST yield, so host_yield
// is entered exactly once for yielding(3). An uninstrumented one keeps
// running and enters it three times.
import fs from 'node:fs';
const path = process.argv[2];
let ex, calls = 0;
const m = await WebAssembly.instantiate(fs.readFileSync(path), {
  env: { host_yield() {
    calls++;
    if (ex.asyncify_get_state() === 2) { ex.asyncify_stop_rewind(); return; }
    ex.asyncify_start_unwind(bufPtr);
  } },
});
ex = m.instance.exports;
const mem = new Int32Array(ex.memory.buffer);
const bufPtr = 1024; mem[bufPtr >> 2] = bufPtr + 8; mem[(bufPtr >> 2) + 1] = bufPtr + 1024;
ex.yielding(3);
const ok = calls === 1;
console.log(`  ${path.padEnd(18)} host_yield entered ${calls}x -> ${ok ? 'SUSPENDED on first yield (instrumented)' : 'ran to completion (NOT instrumented)'}`);
process.exitCode = ok ? 0 : 1;
