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

## zephyr/: calls through the wrong function type (D8b)

Wasm checks the type of every indirect call, so a function called through a
pointer of another type traps (`DESIGN.md` D8b). On every other target it
is undefined behaviour that happens to work. Most of these are thread
entries. A thread entry that is not exactly
`void (*)(void *, void *, void *)` traps as its thread starts.
`K_THREAD_DEFINE()` casts the entry to `k_thread_entry_t`, which is why the
compiler never says so; clang's `-Wcast-function-type-strict` does, and is
how 0001 to 0006 were found.

0007 to 0009 were found differently, from the network suites' traps, and
two of them no compiler warning would find:
- the socket ones put a function in the wrong member of a union;
- the LwM2M test's pointer is unprototyped, `void *(*)()`, which converts
  from anything.

| Patch | Fixes | Here, unlocks |
|---|---|---|
| 0001 `portability: cmsis_rtos_v1` | `zephyr_thread_wrapper()` calls an `os_pthread` through a `void *(*)(void *)`: a library bug, not a sample one | `cmsis_rtos_v1/philosophers` (3 entries) |
| 0002 `samples: basic: threads` | `blink0`, `blink1`, `uart_out` are `void f(void)` | `basic/threads` |
| 0003 `samples: cpp: synchronization` | `coop_thread_entry(void)`, cast by hand | `cpp/cpp_synchronization` (2 entries) |
| 0004 `samples: zbus` | `void f(void)` in six samples, two one-argument entries in `msg_subscriber`, and `int`-returning entries in `benchmark` | seven zbus applications (17 entries) |
| 0005 `tests: kernel: mutex` | `thread_05` to `_08` take two `struct k_sem *` and are cast | `tests/kernel/mutex/mutex_api` |
| 0006 `tests: kernel: pending` | `task_high`, `task_low` are `void f(void)` | `tests/kernel/pending` |
| 0007 `net: lib: quic` | QUIC's socket vtables fill `.close` with `int f(void *)`, but `zvfs_close()` calls a socket's `close2(obj, fd)` | `tests/net/lib/quic`, and gets `lib/http_server/h3` further |
| 0008 `net: sockets: can` | the same, in CAN sockets | nothing here: found by reading, since no CAN suite runs on this board |
| 0009 `tests: net: lib: lwm2m: rd_client` | the stub keeps `void f(struct lwm2m_message *)` callbacks in a `void *(*)()` | `tests/net/lib/lwm2m/lwm2m_rd_client` |
| 0010 `samples: net: sockets: echo_server` | its four thread entries are `void f(void)` | `net/sockets/echo_server`, as a peer for `echo_client` over the two-board link |

Checked against Zephyr `e201b84b` (this workspace's pin) and upstream `main`
at `1ee3b93` (27 September 2026): the series applies to both. checkpatch
reports nothing but the missing `Signed-off-by`, which is deliberate.

`-Wcast-function-type-strict` reports one more kind of cast these patches
leave alone: the minimal libc's `sprintf.c` passes an
`int (*)(int, struct emitter *)` where a `cbprintf_cb` is expected. That is
the same undefined behaviour in C, but wasm checks value types, and every
pointer is an `i32`, so it does not trap here. It would be a separate
change.

## zephyr/: an address buffer too small for IPv6

0011 is a different kind of bug, found by the two-board pairs rather than by
a trap. The echo servers print each client's address, and the address came
out empty in the browser and as a stray byte in Node, for IPv6 clients only.

| Patch | Fixes | Here, unlocks |
|---|---|---|
| 0011 `samples: net: sockets: echo` | `echo`, `echo_async` and `echo_async_select` convert the address into `char addr_str[32]`; `inet_ntop()` needs `INET6_ADDRSTRLEN`, 46, for IPv6, and returns NULL without writing when given less | nothing counted: the pairs already pass, but `echo-one`'s expectation can then name the client (`"Connection #0 from 2001:db8::2"`) |

`dumb_http_server` has the same 32-byte buffer, but it only accepts IPv4,
which fits, so 0011 leaves it alone. The patch applies to the pin and to
upstream `main` at `1ee3b93`; checkpatch reports only the missing
`Signed-off-by`.

## zephyr/: `strcasecmp` for the minimal libc

0012 is a gap rather than a bug. The network shell's `dns` and connection
manager commands call `strcasecmp`, and Zephyr's minimal libc has
`strncasecmp` but not `strcasecmp`, so any application with `CONFIG_NET_SHELL`
and `CONFIG_DNS_RESOLVER` fails to compile when the minimal libc is chosen.
Other boards rarely see it because picolibc is Zephyr's default. This board
chose the minimal libc too, until the mDNS pair ran into it.

| Patch | Fixes | Here, unlocks |
|---|---|---|
| 0012 `libc: minimal: add strcasecmp` | `strcasecmp` declared in the minimal libc's `<strings.h>` and defined next to `strncasecmp`, as `strncasecmp(s1, s2, SIZE_MAX)` | nothing counted: the board now takes picolibc, Zephyr's default (DESIGN.md D11). With 0012 applied, `dns_resolve` builds under the minimal libc too; without it, it stops at `subsys/net/lib/shell/dns.c` |

It applies to the pin and to upstream `main` at `1ee3b93`; checkpatch
reports only the missing `Signed-off-by`.

## zephyr/: sending them

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
3. 0005 and 0006, the kernel tests;
4. 0007 and 0008 together, for the networking maintainers: one bug in two
   socket families;
5. 0009 on its own, for the LwM2M maintainers;
6. 0010 with 0002 to 0004, the samples, or on its own for the networking
   samples' maintainers;
7. 0011 on its own, for the networking samples' maintainers, or with 0010;
8. 0012 on its own, for the C library maintainers.

```sh
git -C zephyr checkout -b thread-entry-signatures origin/main
git -C zephyr am --signoff ../zephyr-wasm/upstream/zephyr/*.patch
```

## mbedtls/: an initialised time in `x509_crt.c`

mbedTLS builds with `-Werror` by default (`MBEDTLS_FATAL_WARNINGS`), and
clang 21 added `-Wuninitialized-const-pointer`. In `x509_crt_verify_chain()`,
`now` is only written when `MBEDTLS_HAVE_TIME_DATE` is defined, and is
passed by pointer either way. Nothing reads it when the option is off, so
the warning is a false positive, but it stops the build on every target
built with clang 21 and that option off, which is Zephyr's default.

| Patch | Fixes |
|---|---|
| 0001 `x509: initialise the time passed to x509_crt_find_parent()` | the build with clang 21 and `MBEDTLS_HAVE_TIME_DATE` off. It zero-initialises `now`, and adds a `ChangeLog.d` entry, since this is a build fix in a supported configuration |

The patch applies to Zephyr's mbedTLS fork at its pin (`098e120`) and to
upstream `development` at `c0748be` (27 September 2026). Until it lands,
`cmake/modules_wasm.cmake` turns that one warning off for the one target
that has it, `mbedx509`, instead of patching the module.

Mbed TLS wants its fixes sent to `Mbed-TLS/mbedtls`, where Zephyr's fork
picks them up. Its contribution rules ask for the Developer Certificate of
Origin, a `Signed-off-by` from the person sending the patch, and this patch
has none for the same reason as the Zephyr ones: it is the sender's to add,
with `git am --signoff`. It carries the same `Assisted-by` placeholder to
fill in.

```sh
git -C mbedtls checkout -b x509-now-init origin/development
git -C mbedtls am --signoff ../zephyr-wasm/upstream/mbedtls/*.patch
```

