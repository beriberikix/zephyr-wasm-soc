// How fast is one context switch? Each iteration is a full unwind of one
// thread's wasm stack and a rewind of another's.
import { makeScheduler } from './driver.mjs';
const N = 20000;
const s = await makeScheduler('fibers.async.wasm', { iterations: N, quiet: true });
const t0 = process.hrtime.bigint();
s.runAll();
const ms = Number(process.hrtime.bigint() - t0) / 1e6;
console.log(`  ${s.switches} switches in ${ms.toFixed(1)} ms`);
console.log(`  ${(ms * 1e6 / s.switches).toFixed(0)} ns per switch, ${(s.switches / ms * 1000 / 1e6).toFixed(2)}M switches/sec`);
