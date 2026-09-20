// The yield now happens inside a function reached through the indirect table,
// which is how Zephyr thread entries and init handlers are reached. A variant
// that skipped instrumenting indirect callees will run straight past it.
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
const bufPtr = 1024; mem[bufPtr >> 2] = bufPtr + 8; mem[(bufPtr >> 2) + 1] = bufPtr + 4096;
ex.compute(2);                       // reaches `sleeper` through the table
const suspended = ex.asyncify_get_state() === 1 && calls === 1;
console.log(`  ${path.padEnd(20)} host_yield entered ${calls}x -> ${suspended ? 'suspended correctly' : 'DID NOT SUSPEND (unsafe for this call path)'}`);
