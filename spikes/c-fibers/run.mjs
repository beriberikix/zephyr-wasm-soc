// Spike C entry point: prove the switching works, then measure what Asyncify costs.
import { makeScheduler } from './driver.mjs';

const wasm = process.argv[2] ?? 'fibers.async.wasm';
const iterations = Number(process.argv[3] ?? 5);
const s = await makeScheduler(wasm, { iterations, trace: process.argv.includes('--trace') });
s.runAll();
console.log(s.log.join('\n'));
console.log(`switches: ${s.switches}`);
