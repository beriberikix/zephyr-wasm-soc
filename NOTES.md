# NOTES — running log

## Loop state
Tick: 6 done  |  Last commit: section shim  |  Blocker: none

**The kernel boots and prints its banner.**

    *** Booting Zephyr OS build e201b84b04e4 ***

That means the section shim works, the init levels run in order, the console
driver binds and printk reaches the host.

Next, and the one thing in the way of hello_world: shortly after the banner an
indirect call traps with `function signature mismatch`, in wasm function 26
called from 14. Wasm checks indirect call signatures exactly, where every
other target tolerates a cast. Somewhere a function pointer is being called
through a type it was not defined with. Worth finding precisely rather than
guessing: it is likely to be a genuine portability finding, not a bug in the
shim.

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
