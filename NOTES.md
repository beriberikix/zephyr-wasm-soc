# NOTES — running log

## Loop state
Tick: 3 done  |  Last commit: M1 configure  |  Blocker: none
Next: get the build to compile and link. Configure now succeeds; the C has
not been compiled yet, so expect real errors in the arch sources and in the
minimal libc's expectations. After that, the post-link wasm-opt step and
host/run.mjs.

Build command (until README.md is written):
  west build -b wasm_node -d build-hello zephyr/samples/hello_world -- \
    -DTOOLCHAIN_ROOT=$POC -DZEPHYR_TOOLCHAIN_VARIANT=wasm-clang \
    -DWASM_MODULE_DIR=$POC -DZEPHYR_EXTRA_MODULES=$POC

### Checklist
- [x] T0 tools installed, workspace created
- [x] M0-A sections spike ... decision recorded
- [x] M0-B offsets spike ... decision recorded
- [x] M0-C fibers spike ... numbers recorded
- [x] M1 toolchain+board configure (west build --cmake-only)
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


### Tick 1 — spike B: the offsets header

Reproduce with `spikes/b-offsets/run.sh`.

Zephyr builds `offsets.h` by compiling `offsets.c` and reading `SHN_ABS`
symbols out of the resulting ELF object. Every architecture creates those
symbols the same way, with an inline-asm `.equ`. On wasm that is not merely
unsupported, it is a hard backend failure:

```
fatal error: error in backend: __k_thread_b_OFFSET: absolute addressing not supported!
```

So the mechanism has to change, not just the parser.

What works is emitting each constant as real data in a section named
`z_offsets`, then reading the value back from the compiler's own assembly
output, where it always appears as a label followed by a width directive:

```
__k_thread_t_b_OFFSET:
        .int32  4
```

Reading the assembly beats reading the object. It is one regex over text the
compiler must emit, instead of scraping two different `wasm-objdump` reports
or writing a wasm binary parser.

`scripts/gen_offsets_wasm.py` does this. Spike B checks all eleven constants
it produces against the layout a real wasm32 program reports, and every one
matches, covering both shapes that appear in practice: file scope, which most
`offsets.c` files use, and inside `GEN_ABS_SYM_BEGIN`, which
`kernel_offsets.h` uses and where clang mangles the name onto the enclosing
function. The generator strips that prefix.

The brief's warning about host compilation is worth quantifying. For the same
struct, the host says 32 bytes with the `prio` member at offset 24; wasm32
says 16 bytes with `prio` at 12. Native compilation would have been wrong by
a factor of two.

This is the port's first and so far only change to the Zephyr tree,
`patches/0001-toolchain-gen-absolute-sym-for-wasm.patch`. It is unavoidable:
`GEN_ABSOLUTE_SYM` is a chain of per-architecture branches ending in `#error`,
with no generic fallback and no out-of-tree hook, so a new architecture cannot
compile `offsets.c` without appearing in that file. `scripts/apply_patches.sh`
applies it and is idempotent.


### Tick 2 — spike C: Asyncify fibers

Reproduce with `spikes/c-fibers/run.sh`; the captured log is `out.log`.

Four threads, each with its own shadow-stack region and its own Asyncify
buffer, switch round-robin under a host driver loop. Each keeps its own state
across suspension and locals survive the unwind and rewind, which the module
checks itself and reports as a failure if it ever stops being true.

**Swapping a thread means swapping two things.** Asyncify saves the wasm
frames into its buffer, but it does not touch `__stack_pointer`, the global
that walks the C shadow stack in linear memory. The host saves and restores
that separately on every switch. wasm-ld exports the global and it is writable
from the host, so no extra machinery is needed. This is exactly the split the
arch will make inside each `K_THREAD_STACK` object.

**Link with wasm-ld directly, not through the clang driver.** The driver drops
the wasm name section. Without names Binaryen cannot match an asyncify
onlylist: it prints a warning, instruments nothing, and produces a module that
looks smaller and silently never suspends. That cost a wrong measurement
before it was caught, and it is a trap worth remembering when the real build
is wired up.

**Cost, on a kernel-shaped module** with a narrow yield path, sixty functions
that never yield, and an indirect call table that can reach a yielding
function, which is the shape Zephyr actually has:

| Build | Size | vs baseline |
|---|---|---|
| baseline | 8168 B | 1.00x |
| full asyncify | 9936 B | 1.22x |
| asyncify with ignore-indirect | 9036 B | 1.11x |
| asyncify with a complete onlylist | 9936 B | 1.22x |

The narrowing options do not help here, and two of them are actively wrong.
Binaryen already instruments only what can transitively reach a suspending
import, so a *correct* onlylist, one naming every frame that can be live
across a yield rather than just the yielding leaf, costs exactly what the full
pass costs. The cheaper-looking variants fail: with `ignore-indirect`, or with
an onlylist naming only the leaf, a yield reached through the indirect table
does not suspend at all. The thread runs straight past it. Since Zephyr
reaches thread entries, init handlers and ISRs indirectly, both are unusable
and the port takes the full pass.

**Speed is the good news.** Code that never yields runs at 1.00x: twenty
thousand rounds of sixty indirect calls each took 9.9 ms instrumented and
9.9 ms not. The instrumentation is paid for in size, not in throughput.

**Switch cost scales with how deep the stack is when a thread yields**, since
Asyncify copies the live frames:

| Depth at yield | ns per switch | Buffer bytes used |
|---|---|---|
| 0 | 220 | 88 |
| 4 | 264 | 216 |
| 16 | 408 | 600 |
| 32 | 595 | 1112 |

That is 88 bytes plus 32 per frame, and roughly 200 ns plus 12 ns per frame.
Measuring this needed care: the first attempt showed a flat line because clang
had turned the recursive test function into an accumulator loop, so there was
no depth to measure.

**The sharp edge: a buffer that is too small corrupts memory silently.**
Asyncify does not bounds-check. Given a 248 byte buffer and a stack needing
1112, it wrote 864 bytes past the end and kept going, with no trap and no
error. `--pass-arg=asyncify-asserts` does not change this; it checks state
transitions, not bounds. The Asyncify half of every thread stack therefore has
to be sized for the deepest stack that thread can reach, and the port should
put something detectable immediately after it.


### Tick 3 — Milestone 1: the build configures

`west build -b wasm_node samples/hello_world --cmake-only` now completes.
That is only configuration: nothing has been compiled yet.

Six things had to be settled to get there, and all but the last were
straightforward once found.

**The SoC directory is keyed by where soc.yml sits.** Putting `soc.yml` at the
top of the SoC tree and the Kconfig files in a subdirectory produced a SoC
directory of `soc/`, so none of the Kconfig files were sourced and `ARCH` came
out undefined. `soc.yml` and the Kconfig files have to be siblings.

**The manifest must declare Zephyr's west extensions.** Without
`west-commands: scripts/west-commands.yml` on the zephyr project, `west build`
does not exist in the workspace at all.

**TOOLCHAIN_ROOT has to supply Zephyr's generic templates too.** Pointing it at
the module makes Zephyr look there for `cmake/linker/target_template.cmake` and
`cmake/compiler/target_template.cmake`, which are not toolchain specific. The
module ships one-line shims that include the originals.

**CMake's compiler probes link an executable**, and wasm-ld refuses to link one
without an entry symbol. `CMAKE_TRY_COMPILE_TARGET_TYPE STATIC_LIBRARY` is the
usual answer for a freestanding target and works here.

**Two more linker hooks were needed** beyond the documented ones:
`toolchain_ld_configure_files` and `toolchain_ld_relocation`. Both generate
linker-script fragments, so both are empty here.

**Substituting the offsets generator was the fiddly part.** Two failures worth
recording. First a dependency cycle: making the generated header depend on
`zephyr_generated_headers` while that target already depends on it is a cycle
CMake rejects outright. Second, `file(GENERATE)` refused to write the flags
response file, because a per-target property such as `INCLUDE_DIRECTORIES` on
an OBJECT library is evaluated once per language and the two evaluations
differed. Only language-neutral properties from `zephyr_interface` can go in
that file; per-target includes are plain CMake values and are passed directly.

A third Zephyr patch was needed, for the same reason as the first two: the arch
dispatch headers `include/zephyr/arch/cpu.h` and
`include/zephyr/arch/arch_inlines.h` are hardcoded `#elif` chains ending in
`#error`, with no out-of-tree hook. Shadowing them from the module was the
alternative and was rejected: it depends on winning an include-path race and
means carrying a copy of a header that moves upstream.
