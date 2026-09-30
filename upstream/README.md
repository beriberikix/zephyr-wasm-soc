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

0017 is the first kind again, in the file layer every file goes through,
and was found by `posix/eventfd` once the port reached its `main`.

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
| 0017 `lib: os: zvfs: call read and write through the member the vtable fills` | `zvfs_rw()` calls every file's `read_offs()` or `write_offs()`, which only shared memory fills. Eventfd, sockets and the console fill `read()` and `write()`, the other members of the same unions | `posix/eventfd`, whose first `write()` traps without it. Checked against the pin and upstream `main` on 30 September 2026 |

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

## zephyr/: network samples the host's LAN found

The host's own network (`host/lan.mjs`, `DESIGN.md` D8m) gave two more
network samples a peer, and each stopped on a bug that is not this
board's.

| Patch | Fixes | Here, unlocks |
|---|---|---|
| 0013 `net: lib: coap: coap_client_tcp: count a request as sent from the start` | a request stamped with `k_uptime_get()` in the first millisecond of uptime has a `tcp_t0` of 0, which `exchange_lifetime_exceeded()` takes to mean "never sent", so the receive thread goes back to sleep without reading the reply. The stamp was also set after the receive thread was woken | `sockets/coap_client_tcp` against the LAN's CoAP-over-TCP server, which as it is stops at "Timeout waiting for CSM exchange": a board here connects 0.4 ms after it starts |
| 0014 `samples: net: sockets: dumb_http_server_mt` | `process_tcp4` and `process_tcp6` are `void f(void)` thread entries, as echo_server's were (0010) | `sockets/dumb_http_server_mt`, which then serves its page to the LAN's dial |
| 0015 `samples: net: mqtt_sn_publisher: match thread entry to k_thread_entry_t` | `process_thread` is a `void f(void)` thread entry | `net/mqtt_sn_publisher`, which then connects to the LAN's MQTT-SN gateway, subscribes, registers its topic and publishes every 10 s |
| 0016 `samples: net: ipv4_autoconf: register the event handler at build time` | `main()` registers for `NET_EVENT_IPV4_ADDR_ADD` only once it runs, but autoconf adds its address as soon as the interface is up. Where the link is up during boot, as here, that is earlier, and the address is never printed although it is probed for and announced | `net/ipv4_autoconf`, which then prints its 169.254 address. It uses `NET_MGMT_REGISTER_EVENT_HANDLER()`, as the autoconf code registers its own |

Each applies to the pin and to upstream `main` as fetched when it was
written (0013 and 0014 on 29 September 2026, 0015 and 0016 on 30
September), and checkpatch reports only the missing `Signed-off-by`.
`try_upstream.sh` does not run these, since the sweep leaves out
`harness: net` samples. Check them by hand: apply the patch, build the
sample with `-DSNIPPET=wasm-ethernet`, and run it with `run.mjs --lan`, or
for the server `--lan-dial 1000:8080`.

The UDP CoAP client (`coap_client.c`) has the same `t0 == 0` test on
`pending.t0`. None of the samples here sends that early, so it is only
noted.

`websocket_client` has a third bug, which needs no patch from here. At this
workspace's pin its handshake fails with "Cannot calculate sha1 (-134)"
on every target: commit f331614 moved the websocket library to PSA and
selected `PSA_WANT_ALG_SHA_256`, but the handshake hashes with SHA-1.
Upstream `main` selects `PSA_WANT_ALG_SHA_1`, so the sample counts once the
pin moves past that fix.

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
8. 0012 on its own, for the C library maintainers;
9. 0013 on its own, for the CoAP maintainers;
10. 0014, 0015 and 0016 with 0010, or on their own, for the networking
    samples' maintainers;
11. 0017 on its own, for the maintainers of `lib/os/zvfs`, or with 0007
    and 0008, which are the same kind of bug in the same unions.

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


## rootlessrelay/: a relay on the samples' own subnet

The uplink (`host/uplink.mjs`, `DESIGN.md` D8l) sends a board's frames to a
relay that speaks v86's wsproxy protocol, and RootlessRelay is the one
README points people at: it needs neither root nor a TAP device. Its
`GATEWAY_IP` is configurable, but two things assumed QEMU's `10.0.2.0/24`:
- the DHCP pool, the broadcast address and the VM-to-VM check were fixed at
  `10.0.2.x`, so `GATEWAY_IP=192.0.2.2` offered `10.0.2.15` with a gateway
  outside its subnet;
- a DNS query sent to the gateway went to the gateway's address on the real
  network, where nothing answers. QEMU's user networking answers DNS at its
  own address.

Most of Zephyr's networking samples ship with a static `192.0.2.1`, and the
gateway `192.0.2.2` as their DNS server, so neither worked through the relay
as it is. Only a sample that asks DHCP for everything, such as
`dhcpv4_client`, did.

| Patch | Fixes | Here, unlocks |
|---|---|---|
| 0001 `Take the VM subnet from GATEWAY_IP, and answer DNS sent to the gateway` | the /24 is the gateway's; a query to the gateway goes to `DNS_SERVER_IP` and is answered from the gateway's address | static-address samples, run as shipped with `GATEWAY_IP=192.0.2.2 DHCP_START=1 DHCP_END=1`. `sockets/http_get` fetched `http://google.com` through it, unmodified |

It applies to `obegron/rootlessRelay` `main` at `1b541e2` (0.6.0), and the
project's own tests pass with it (82 pass, 34 network tests skipped). The
project is MIT-licensed and asks for nothing more than a pull request; the
patch carries the same `Assisted-by` placeholder to fill in.

```sh
git -C rootlessRelay checkout -b gateway-subnet origin/main
git -C rootlessRelay am ../zephyr-wasm/upstream/rootlessrelay/*.patch
```

## tcpip.js: chained buffers in the tap interface (to report)

The host's LAN (`host/lan.mjs`, `DESIGN.md` D8m) runs tcpip.js's
`tcpip.wasm` 0.4.0. Its tap interface hands a sent frame to JavaScript as
`p->payload` and `p->tot_len` (`packages/tcpip/wasm/tap_interface.c`,
`tap_interface_output`). When lwIP adds a write to a TCP segment that has
not been sent yet, it chains a second buffer onto it, and that frame goes
out as the first buffer followed by whatever is next in memory. It fails its
checksum at the other end, and fails again on every retransmission, so the
connection stops. An echo of 4 MB between two tcpip.js stacks came back
2,256 bytes short, and every size from about 3.5 MB to 4 MB stopped the
same way (`scripts/check_lan.mjs` reproduces it with the fix taken out).
The receive side has the same shape: `recv_tcp_callback` and
`recv_udp_callback` pass `p->payload` and `p->len`, and free the rest of a
chain.

This is written up as an issue rather than a patch: the fix is in C, and
it can't be built and tested here without their Docker build. The fix it
would suggest is to copy the chain out with `pbuf_copy_partial()` in all
three places, or to call the import once per buffer. Until then, `lan.mjs`
finds the chain from JavaScript (`Lan.frameAt`), and the receive side is
safe on this wire because segments always arrive in order.
