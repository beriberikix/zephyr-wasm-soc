/* SPDX-License-Identifier: Apache-2.0 */
// Walk the generated init table exactly the way z_sys_init_run_level does.
import fs from 'node:fs';
const m = await WebAssembly.instantiate(fs.readFileSync(process.argv[2]), {});
const e = m.instance.exports;
const names = ['EARLY', 'PRE_KERNEL_1', 'PRE_KERNEL_2', 'POST_KERNEL', 'APPLICATION', 'end'];
const base = e.addr(0);
let prev = base, ok = true;
names.forEach((n, i) => {
  const a = e.addr(i);
  console.log(`  ${n.padEnd(14)} offset ${a - base}`);
  if (a < prev) ok = false;
  prev = a;
});
console.log('  monotonic and contiguous:', ok);
for (let l = 0; l < 5; l++) console.log(`  walk(${names[l]}) visits fn ids: ${e.walk(l)}`);
