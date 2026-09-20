# NOTES — running log

## Loop state
Tick: 7 done  |  Last commit: empty levels and stack sizing  |  Blocker: none

The signature-mismatch trap is fixed and the kernel gets further: it boots,
switches to the main thread, and reaches `bg_thread_main`. It does not reach
the greeting.

Two things to chase next, in order:

1. **`bg_thread_main` appears to run twice.** The banner prints twice with one
   switch between. Note that the banner goes to stdout and the trace to
   stderr, so their relative order in a terminal is not evidence; the doubling
   is. Most likely the host re-enters a fresh context instead of rewinding, or
   the switch block is read when it holds stale values.
2. **Then a kernel panic.** Worth confirming whether it is a consequence of
   the first or independent.

The prime suspect for both is `z_wasm_switch` recovering the outgoing thread
with `CONTAINER_OF(switched_from, struct k_thread, switch_handle)`. If that is
not what the kernel passes, `from_buf` is garbage and the unwind writes over
whatever it points at. Verify that before anything else: add a trace of
`from_buf`/`to_buf` per switch and check both against the real thread objects.

### Tick 5 — Asyncify step and the host harness

The post-link step is wired and `zephyr.wasm` is produced: 300285 bytes in,
317629 out, so Asyncify costs 1.06x on the real kernel. That sits below the
1.22x spike C measured on a synthetic module, which makes sense, since the
real kernel has proportionally more code that cannot reach a suspending
import.

One ordering trap. The name of the final link target is only decided near the
end of Zephyr's top-level `CMakeLists.txt`, long after a SoC file is read, so
the obvious `DEPENDS` on it silently depends on nothing and the transform runs
*before* the link, on a stale file. The step now hangs off a deferred call
that runs once that directory has been processed.

`host/run.mjs` is written. It supplies the six imports, owns the clock, raises
interrupts and drives the Asyncify loop, with `--realtime`, `--trace-switches`
and `--max-time`. Two details worth recording.

Rewinding must re-enter through the same export that first entered, so the
host keeps a small table of live contexts keyed by Asyncify buffer address,
each remembering its entry point and argument. And the kernel boots on a dummy
thread with no stack object, so there is no buffer to unwind into at the first
switch. Nothing needs saving, but Asyncify still writes while unwinding, so
the arch now exports a scratch buffer used exactly once.

**Dropping `--allow-undefined` was the most useful change of the tick.**
Without it wasm-ld turns every unresolved symbol into an import from a module
named `env`, the link succeeds, and the failure surfaces at instantiation as
`Import #6 "env": module is not an object or function`, which names neither
the symbol nor the reason. That had been masking a missing kernel hook and,
behind it, the twelve section symbols. Failing at link time prints the names.

So the build is red on purpose, at exactly the point spike A predicted it
would be.


### Tick 6 — the section shim, and the banner

The kernel boots. That took two mechanisms, matching the split spike A called
for, and the split held up.

**Renaming, for lists where order carries no meaning.** Patch 0004 makes
`TYPE_SECTION_ITERABLE` use a C identifier for the section name on wasm and
makes the bounds macros resolve to `__start_`/`__stop_`, which wasm-ld
synthesises. No generated code at all for these.

**Generation, for the init entries.** They must form one contiguous block
ordered by level and then priority, which no amount of renaming achieves.
`scripts/gen_sections_wasm.py` reads the compiled objects, recovers each
entry's level and priority from the segment name Zephyr already encodes, and
emits per-level arrays that are filled at boot by copying each entry into its
sorted place. Copying is safe because nothing holds a pointer to an init
entry, and the arrays are sized at build time, so boot does a fixed sequence
of assignments with no sorting and no allocation.

Three things about this were not obvious.

**Pay-per-use lists break the renaming half.** Several iterable lists exist
only if their subsystem is linked; a build that never uses mailboxes has no
mailbox entry. Under a linker script that yields an empty range. wasm-ld
instead fails on a reference to the bounds of a section nothing defines. The
generator now emits a weak, zero-length definition for every family named
anywhere in the objects: where the section exists wasm-ld's strong symbols
win, and where it does not, start and end coincide and the list reads as
empty. An anchor member was tried first and rejected, because an anchor in a
list of static threads would be a bogus thread.

**Those fallbacks need a file of their own.** Put beside the init arrays they
conflict, because that file includes Zephyr headers which declare some of the
same symbols with real element types.

**The generator sees more than the linker keeps.** It scans every compiled
object, including ones the link discards, so a family can look populated and
still be absent from the image. That is what makes the weak fallback the right
shape rather than a conditional one.

Patch 0003 was also needed: `SYS_INIT` declares its entries `static`, and the
generated copy has to name them. The patch makes the storage class conditional
so only wasm changes.


### Tick 7 — two real bugs, and how wasm reports them

**An empty init level was being walked.** The generator rounded every level's
array up to one element, so a level with no entries left a zeroed entry inside
the range `z_sys_init_run_level` walks, and the kernel called a null function
pointer. On hardware that faults at a null address. In wasm a null function
pointer is table slot 0, so the call is an indirect call with the wrong type
and the engine reports `function signature mismatch`, which points at the
callee rather than at the null. Empty levels are now genuinely zero-length, so
a level's start coincides with the next level's.

This is worth keeping as a portability note. Wasm checks indirect call
signatures exactly, where other targets tolerate a cast, so a class of
mistakes that would be a wild jump elsewhere surfaces here as a type error at
the call site.

**The Asyncify reservation was larger than the default stacks.** Every thread
stack object yields `ARCH_THREAD_STACK_RESERVED` bytes to its Asyncify buffer,
and the default main stack is 1024 bytes against a 4096-byte reservation, so
the split ran off the bottom of the object. The board now sets stack sizes
that clear the reservation with room left over. This is a real cost of the
approach and belongs in the final report: on this port every thread pays for
an Asyncify buffer whether or not it ever suspends deeply.
