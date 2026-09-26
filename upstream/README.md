# Changes proposed to upstream projects

`patches/` holds what this port needs Zephyr and picolibc to accept before
it can build at all, and `scripts/apply_patches.sh` applies it. This
directory holds something different: bugs the port found that are bugs on
every target, written up as changes to send upstream. Nothing here is
applied to the workspace. The score counts samples that run on Zephyr as it
is, so a sample these fix does not count until Zephyr takes the fix and the
pin moves.

`scripts/try_upstream.sh` applies them for one run, re-runs the samples and
kernel suites they are meant to fix, and takes them back out.

## zephyr/: thread entries that match `k_thread_entry_t` (D8b)

Wasm checks the type of every indirect call, so a thread entry that is not
exactly `void (*)(void *, void *, void *)` traps as its thread starts
(`DESIGN.md` D8b). On every other target it is undefined behaviour that
happens to work. `K_THREAD_DEFINE()` casts the entry to `k_thread_entry_t`,
which is why the compiler never says so; clang's
`-Wcast-function-type-strict` does, and is how these sites were found.

| Patch | Fixes | Here, unlocks |
|---|---|---|
| 0001 `portability: cmsis_rtos_v1` | `zephyr_thread_wrapper()` calls an `os_pthread` through a `void *(*)(void *)`: a library bug, not a sample one | `cmsis_rtos_v1/philosophers` (3 entries) |
| 0002 `samples: basic: threads` | `blink0`, `blink1`, `uart_out` are `void f(void)` | `basic/threads` |
| 0003 `samples: cpp: synchronization` | `coop_thread_entry(void)`, cast by hand | `cpp/cpp_synchronization` (2 entries) |
| 0004 `samples: zbus` | `void f(void)` in six samples, a one-argument entry in `msg_subscriber`, and `int`-returning entries in `benchmark` | seven zbus applications (17 entries) |
| 0005 `tests: kernel: mutex` | `thread_05` to `_08` take two `struct k_sem *` and are cast | `tests/kernel/mutex/mutex_api` |
| 0006 `tests: kernel: pending` | `task_high`, `task_low` are `void f(void)` | `tests/kernel/pending` |

Checked against Zephyr `e201b84b` (this workspace's pin) and upstream `main`
at `6f1ab6c` (26 September 2026): the series applies to both. checkpatch
reports nothing but the missing `Signed-off-by`, which is deliberate.

`-Wcast-function-type-strict` reports one more kind of cast these patches
leave alone: the minimal libc's `sprintf.c` passes an
`int (*)(int, struct emitter *)` where a `cbprintf_cb` is expected. That is
the same undefined behaviour in C, but wasm checks value types, and every
pointer is an `i32`, so it does not trap here. It would be a separate
change.

### Sending them

Zephyr's contribution guidelines have a section on AI-assisted changes
(`doc/contribute/guidelines.rst`, "Contributions using AI tools"). It says
two things these patches depend on:
- an AI agent must not add `Signed-off-by`, so these have none: the person
  sending them adds their own, with `git am --signoff`, having reviewed the
  change and taken responsibility for it;
- AI help is disclosed with an `Assisted-by: <agent>:<model version>` tag.
  Each patch carries `Assisted-by: Claude:MODEL-VERSION`; replace
  `MODEL-VERSION` with the version shown for the session before sending.

A suggested split, by who maintains what:
1. 0001 on its own: it changes a library, and its maintainers are not the
   samples' maintainers;
2. 0002, 0003 and 0004 together, or 0004 separately for the zbus
   maintainers;
3. 0005 and 0006, the kernel tests.

```sh
git -C zephyr checkout -b thread-entry-signatures origin/main
git -C zephyr am --signoff ../zephyr-wasm/upstream/zephyr/*.patch
```
