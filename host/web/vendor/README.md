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
