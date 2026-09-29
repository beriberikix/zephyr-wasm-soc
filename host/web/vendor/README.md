# Vendored: xterm.js

The page's terminal. Zephyr's shell draws its line editor with VT100
escapes (cursor movement, clearing to the end of the line) and some samples
position text on the screen, so anything short of a terminal emulator shows
something other than what the guest drew. xterm.js is the standard one.

Copied from the npm packages, unmodified except that the trailing
`sourceMappingURL` comment is removed, since the maps are not shipped:

| file             | package                  | from                    |
|------------------|--------------------------|-------------------------|
| `xterm.mjs`      | `@xterm/xterm` 6.0.0     | `lib/xterm.mjs`         |
| `xterm.css`      | `@xterm/xterm` 6.0.0     | `css/xterm.css`         |
| `addon-fit.mjs`  | `@xterm/addon-fit` 0.11.0| `lib/addon-fit.mjs`     |
| `LICENSE.xterm`, `LICENSE.addon-fit` | both, MIT | `LICENSE`        |

Tarball SHA-256, as `npm pack` fetched them:

    908e66e04af6c8dc6b00dd3b54de088e2e81e5ed866284fd6c2fb3c2d1c7a3f6  xterm-xterm-6.0.0.tgz
    26003b4517a132b64e4ff228fd88a5fda3fff5e606c76093f6dcff772e9ecec0  xterm-addon-fit-0.11.0.tgz

To update: `npm pack @xterm/xterm@<v> @xterm/addon-fit@<v>`, unpack, copy
the same files, drop the `sourceMappingURL` line, update this table, and run
`scripts/check_browser.mjs`, which types into the shell with real key
presses and reads back what the screen shows.

# Vendored: lwIP, as tcpip.js builds it

The host's own network, the LAN a board can be plugged into
(`host/lan.mjs`, `DESIGN.md` D8m), is lwIP, compiled to wasm by tcpip.js.
Only the wasm is taken: tcpip.js's JavaScript drives lwIP from a wall-clock
`setInterval` through async streams, and the LAN has to run on the board's
virtual clock, one call at a time, so `host/lan.mjs` is its own glue to the
module's exports.

| file           | from                                   |
|----------------|----------------------------------------|
| `tcpip.wasm`   | `tcpip` 0.4.0, `tcpip.wasm` (lwIP `STABLE-2_2_0_RELEASE` and tcpip.js's C glue) |
| `LICENSE.tcpip`| `tcpip` 0.4.0, `LICENSE` (MIT)         |
| `LICENSE.lwip` | lwIP `STABLE-2_2_0_RELEASE`, `COPYING` (BSD-3-Clause) |

    77a1138753362dcfd7faa49ec18edc47f596f59dbb3e0f025bd99d1c87dcfeee  tcpip-0.4.0.tgz
    100e5060d708cc0b54fed3eb48d7f155d3a4cf3e6708ade464605e8e5f94d9e5  tcpip.wasm

To update: `npm pack tcpip@<v>`, copy `tcpip.wasm` and `LICENSE`, check its
imports and exports still match what `host/lan.mjs` binds, update this
table, and run `scripts/check_site.mjs`, which runs every LAN build twice
and requires the same output.
