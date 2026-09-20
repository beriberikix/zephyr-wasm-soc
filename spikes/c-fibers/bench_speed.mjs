// compute() never yields, but under a full asyncify pass it is instrumented
// anyway because the indirect table can reach one function that does. This
// measures what that costs on ordinary work.
import fs from 'node:fs';
const paths = process.argv.slice(2);
const ROUNDS = 20000, REPS = 5;
const results = [];
for (const p of paths) {
  const m = await WebAssembly.instantiate(fs.readFileSync(p), { env: { host_yield() {} } });
  const ex = m.instance.exports;
  ex.compute(100); // warm up
  let best = Infinity;
  for (let r = 0; r < REPS; r++) {
    const t0 = process.hrtime.bigint();
    ex.compute(ROUNDS);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    if (ms < best) best = ms;
  }
  results.push([p, best]);
}
const base = results[0][1];
for (const [p, ms] of results) {
  console.log(`  ${p.padEnd(20)} ${ms.toFixed(1).padStart(8)} ms   ${(ms / base).toFixed(2)}x`);
}
