# NOTES — running log

## Loop state
Tick: 0  |  Last commit: 7502d7f scaffolding  |  Blocker: none

### Checklist
- [x] T0 tools installed, workspace created
- [x] M0-A sections spike ... decision recorded
- [ ] M0-B offsets spike ... decision recorded
- [ ] M0-C fibers spike ... numbers recorded
- [ ] M1 toolchain+board configure (west build --cmake-only)
- [ ] M1 link zephyr.elf -> zephyr.wasm (post-link wasm-opt)
- [ ] M1 host/run.mjs boots to banner
- [ ] M1 threads switch (synchronization sample)
- [ ] M1 timer + k_msleep, virtual time
- [ ] M2-1 hello_world
- [ ] M2-2 synchronization
- [ ] M2-3 ztest
- [ ] M2-4 determinism script
- [ ] README.md acceptance commands verified from clean checkout
- [ ] M3 preemption (optional)
- [ ] M3 instr-count clock (optional)
- [ ] M3 twister (optional)
- [ ] M3 uart+shell (optional)
- [ ] Final report

---

## Log

### Tick 0 — environment survey

Tools found before installing anything:

| Tool | State |
|---|---|
| Node.js | v26.8.2 |
| cmake | 4.4.3 |
| ninja | present |
| west | v1.5.0 (uv tool; its Python has pyelftools and pykwalify) |
| Apple clang 21 | compiles wasm32 objects, ships no wasm-ld |
| Zephyr SDK 1.0.1 | ships wasm-ld 19, its clang has no wasm32 target |
| wasm-opt | missing |
| wasm-objdump | missing |

Neither existing clang/wasm-ld pair is usable on its own, so Homebrew LLVM,
Binaryen and wabt were installed to get one matched set.

After installing, the versions are:

| Tool | Version | Path |
|---|---|---|
| clang | 23.1.1 | `/opt/homebrew/opt/llvm/bin` |
| wasm-ld | 23.1.1 | `/opt/homebrew/opt/lld/bin` |
| wasm-opt | 132 | `/opt/homebrew/bin` |
| wasm-objdump | 1.0.42 | `/opt/homebrew/bin` |

Two surprises during install, both recorded because they will bite anyone
reproducing this. Homebrew's `llvm` formula at version 23 no longer bundles
lld, so `wasm-ld` needs the separate `lld` formula; the two happen to be the
same version, which is what we wanted. And `wabt` installed without being
linked, because binaryen already owns the `wasm2c` name, so it needed
`brew link --overwrite wabt`. Both formulas are keg-only, so `tools.env`
carries the paths.

Smoke test passes end to end: compile a C file to a wasm32 object, link it
with wasm-ld, run it under Node, and run `wasm-opt --asyncify` over the
result. A trivial module grew from 701 to 831 bytes under Asyncify, which is
only a floor, not a useful overhead number: spike C measures the real one.

Known risk recorded up front: Homebrew LLVM ships no wasm32 compiler-rt
builtins. If the link reports unresolved `__*` helper symbols, the order of
attack is (1) see which symbols actually go unresolved, (2) add a small
`builtins.c` to the module, (3) as a last resort take
`libclang_rt.builtins-wasm32.a` from a wasi-sdk release.

### Zephyr integration points (verified by reading the tree)

Friction points that shape the design, with the approach chosen for each:

1. **Arch dispatch headers are hardcoded.** `include/zephyr/arch/cpu.h` and
   `include/zephyr/arch/arch_inlines.h` are `#elif` chains ending in `#error`.
   Plan: the module ships shadow copies with a `CONFIG_WASM` branch and puts
   its include dir first. Fallback: a numbered patch.
2. **The build insists on a linker script.** The root `CMakeLists.txt`
   fatal-errors when `LINKER_SCRIPT` does not exist. Plan: a placeholder
   script plus a module-owned `configure_linker_script()` that does nothing.
3. **`offsets.h` comes from ELF.** `gen_offset_header.py` reads `SHN_ABS`
   symbols from an ELF object. The offsets library is declared at root
   `CMakeLists.txt:1044`, after `add_subdirectory(arch)` at 764, so
   `arch/wasm/CMakeLists.txt` can redefine `zephyr_constants_library` and
   substitute a wasm-aware generator. Spike B picks how to read the values.
4. **Post-link bintools assume ELF.** `bintools_template.cmake` already
   defaults every command to a no-op echo, and `elfconvert_formats` defaults
   empty, so a bintools dir that declares nothing makes those steps harmless.
5. **Twister's `arch` enum is closed** and has no `wasm`. Only matters for the
   Milestone 3 twister runner.


### Tick 0 — spike A: linker sections

Reproduce with `spikes/a-sections/run.sh`; the captured log is `out/spike-a.log`.

What wasm-ld does:

| Question | Answer |
|---|---|
| `__start_X`/`__stop_X` for C-identifier section names | Yes, synthesised, same as ELF |
| Ordering of same-named segments | Input order only: object order on the command line, then declaration order inside each object |
| Sorting by segment or symbol name | Never. Declaring 90, 10, 50 gives back 90, 10, 50 |
| Dotted names such as `.z_init_POST_KERNEL_P_50_SUB_0_` | Preserved verbatim, in the object and in the linked module, but get no start/stop symbols because they are not C identifiers |
| `--defsym` to bridge a name | Not supported at all |
| Referencing a section no object defines | Link error, not an empty range |
| Ordering knobs | None. Only `--merge-data-segments` |

So wasm-ld gives bounds but never ordering, and there is no link-time way to
rename a symbol.

The thing that makes a clean answer possible is that wasm object files carry a
`linking` custom section that maps every symbol to its full segment name,
dots and all:

```
- symbol table [count=4]
 - 0: D <init_a> segment=0 offset=0 size=4
- segment info [count=4]
 - 0: .z_init_POST_KERNEL_P_50_SUB_0_ p2align=2 [ RETAIN ]
```

A build step can therefore recover each entry's level and priority from the
name Zephyr already encodes, without parsing anything ELF-shaped.

The constraint that shapes the decision is in `kernel/init.c`. Its
`z_sys_init_run_level` walks `levels[level]` up to `levels[level+1]`, so the
six level symbols are not independent bounds: every init entry must sit in one
contiguous block, ordered by level and then by priority. Bounds alone are not
enough, which rules out the pure renaming approach for init entries.

Question 9 settles how to satisfy that. Per-level arrays defined next to each
other in a single translation unit land contiguous and in declaration order,
and walking them the way the kernel does visits exactly the right entries:

```
EARLY          offset 0     walk visits 1,2
PRE_KERNEL_1   offset 16    walk visits 3
PRE_KERNEL_2   offset 24    walk visits 4,5
POST_KERNEL    offset 40    walk visits 6
APPLICATION    offset 48    walk visits 7
end            offset 56
```

That is a generated file the kernel accepts as-is, with no patch to
`kernel/init.c`.
