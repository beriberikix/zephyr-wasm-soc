/* SPDX-License-Identifier: Apache-2.0 */
// Print the contents of the zsec/zord array as the linked module sees it.
import fs from 'node:fs';
const [, , file, label] = process.argv;
const m = await WebAssembly.instantiate(fs.readFileSync(file), {});
const e = m.instance.exports;
const n = e.count();
const vals = [];
for (let i = 0; i < n; i++) vals.push('0x' + (e.at(i) >>> 0).toString(16));
console.log(`  ${label}: start=${e.start_addr()} stop=${e.stop_addr()} count=${n}`);
console.log(`  contents: ${vals.join(' ')}`);
