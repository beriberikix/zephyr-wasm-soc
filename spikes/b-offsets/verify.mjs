// Cross-check the generated offsets.h against the layout the wasm32 compiler
// actually produces. Names follow Zephyr's own convention: GEN_OFFSET_SYM(S,M)
// makes __<S>_<M>_OFFSET, so a typedef already starting with _ yields three
// leading underscores, exactly as kernel/include/offsets_short.h expects
// (___cpu_t_nested_OFFSET).
import fs from 'node:fs';
const names = [
  '___callee_saved_t_sp_OFFSET', '___callee_saved_t_asyncify_buf_OFFSET', '__callee_saved_t_SIZEOF',
  '__struct_arch_esf_pc_OFFSET', '___cpu_t_current_OFFSET', '___cpu_t_nested_OFFSET',
  '___cpu_t_irq_stack_OFFSET', '___thread_t_callee_saved_OFFSET', '___thread_t_init_data_OFFSET',
  '___thread_t_prio_OFFSET', '__thread_t_SIZEOF',
];
const hdr = fs.readFileSync('out/offsets.h', 'utf8');
const m = await WebAssembly.instantiate(fs.readFileSync('out/verify.wasm'), {});
let ok = true;
names.forEach((n, i) => {
  const hit = hdr.match(new RegExp(`#define ${n} 0x([0-9a-f]+)`));
  const got = hit ? parseInt(hit[1], 16) : null;
  const want = m.instance.exports.v(i);
  const pass = got === want;
  if (!pass) ok = false;
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${n.padEnd(40)} header=${got} actual=${want}`);
});
console.log(ok ? '  RESULT: every constant matches the real wasm32 layout' : '  RESULT: MISMATCH');
process.exit(ok ? 0 : 1);
