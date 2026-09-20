/* SPDX-License-Identifier: Apache-2.0 */
// Asyncify copies the live wasm frames into the buffer on every unwind, so the
// time per switch and the bytes needed both grow with how deep the stack is
// when a thread yields. That is what sizes the Asyncify half of a thread stack.
import { makeScheduler } from './driver.mjs';

async function measure(depth, iterations) {
  const s = await makeScheduler('fibers.async.wasm', { iterations, quiet: true, yieldDepth: depth });
  const t0 = process.hrtime.bigint();
  s.runAll();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { ns: ms * 1e6 / s.switches, bytes: s.peakBufferUse, switches: s.switches };
}
// Warm the JIT before any timed run, otherwise the first depth absorbs it.
await measure(4, 2000);
console.log('  depth   ns/switch   asyncify bytes used');
for (const depth of [0, 2, 4, 8, 16, 32]) {
  const r = await measure(depth, 4000);
  console.log(`  ${String(depth).padStart(5)}   ${r.ns.toFixed(0).padStart(9)}   ${String(r.bytes).padStart(19)}`);
}
