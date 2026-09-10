# Native terminal checkpoints

Native remains an explicit backend choice. This change does not run tmux under
native and does not change the default backend. The supervisor owns PTYs and
bounded terminal state; a Nexus server restart does not restart their programs.
A native **supervisor** restart does interrupt them and requires deliberate
deployment with `--restart-native-pty`.

## Recovery contract

The reader decodes incremental UTF-8, observes the output and forwards the live
bytes unchanged. Each native entry serializes output, snapshot creation and
subscription with the same state lock. Attach returns `native-snapshot` and
sends an ANSI checkpoint before any subsequent output for that client. A
checkpoint restores the visible screen, primary/alternate buffers, saved cursor,
attributes, margins, tabs, input modes and unfinished control prefix.

The browser negotiates `terminalProtocol=2`. A binary `native-state` control
contains `version:1`, `replayPolicy:"native-snapshot"`, `unicodeVersion:"11"`,
`cols` and `rows`; the next
text frame is the corresponding checkpoint. Geometry and snapshots enter a
single browser write queue, behind earlier output. Unknown/malformed controls
fail closed. Native connections without protocol 2 are refused with 4002 rather
than rendering a checkpoint at the wrong dimensions. Text that resembles JSON
is still terminal output, never a control message.

Native uses a shared logical PTY size: the minimum requested width and height
among attached clients, bounded to 10–500 columns and 5–200 rows. Every client
gets a checkpoint when that size changes. Larger clients keep that logical grid
instead of continually overriding a smaller client's size. Disconnect recomputes
the remaining size. A fit whose request does not change shared dimensions still
receives a checkpoint to restore the requesting browser's canonical grid.

State uses [asciinema avt 0.18.0](https://github.com/asciinema/avt), with a pinned,
Apache-2.0 source patch. Independent tests found upstream's character widths and
combining cells did not match the pinned xterm 6 browser. The patch aligns width
tables (official Unicode 11 addon on the browser), preserves combining cells and
restores last-print joining/REP state. Unicode policy mismatch fails closed.
See `rust-runtime/vendor/avt/NEXUS-PATCHES.md`; its tests and the cross-engine
Chrome tests are release gates. `vte` observes complete negotiated input modes;
it never identifies an application by its title or text.

## Explicit channel scroll profiles

Optional `$NEXUS_DATA_DIR/terminal-profiles.json` (next to
`project-shell-defaults.json`) is read on each WebSocket attach:

```json
{
  "version": 1,
  "channels": [
    { "session": "my-project", "windowIndex": 0, "scroll": "application-sgr" },
    { "session": "my-project", "windowIndex": 1, "scroll": "auto" }
  ]
}
```

This is an explicit launch/channel capability declaration, not an application
name heuristic. It applies to tmux and native, across refresh and devices.
Priority is standard mouse tracking → configured profile → temporary per-view
manual selection. `auto` explicitly retains normal history behavior without a
manual SGR fallback. No entry retains the existing temporary selector behavior.
Remove an entry and reconnect to remove its policy. Unknown versions/values,
duplicates and oversized files are ignored; no capabilities are guessed. There
is no new settings-write API or automatic migration of existing channels.

## Limits and operational boundary

- The checkpoint retains 200 history rows; the existing bounded scrollback file
  remains the history-view source. This is not unlimited session recording.
- Control prefixes are limited to 4 KiB; combining runs to 256 characters and
  cell combining storage to 1 KiB. Exceeding recovery limits preserves the raw
  live stream but explicitly refuses subsequent checkpoint recovery; create a
  new channel. It never returns a silently truncated checkpoint as successful.
- Browser pending output is capped at 32 Mi UTF-16 code units; overload closes
  1013 for recovery. EOF is notified after the reader drains remaining output.
- A serialized checkpoint is capped at 8 MiB. Internal JSON-line writers use
  a 16-message bounded queue with producer backpressure, not unbounded buffering.
- Completed terminal queries and OSC 52 clipboard effects are not replayed.
  Titles are bounded and sanitized. Proprietary graphics/extensions (for example
  sixel, kitty images and OSC 8 link metadata) are not a certified checkpoint
  capability. This does not claim compatibility with every terminal extension.
- A server/browser reconnect is not a supervisor/host crash. Native supervisor
  memory is not durably checkpointed; restarting it interrupts child programs.
- Acceptance covers real PTY fixtures, shell lifecycle, desktop and mobile
  browser emulation. Real AI inference and physical-device coverage must be
  reported separately; fixture success is not provider quota or phone evidence.

## Verification and rollout

`npm run check` includes the vendored state library tests, Rust/Node/browser
regressions and built frontend parity. Also run Rust fmt/clippy and release bins.
`npm run smoke:native` runs an isolated real supervisor + release server + Chrome
acceptance. `npm run smoke:native -- --live` uses the local e2e secret, creates its
own native project, tests the actual HTTPS deployment and removes that project.
Personal workspace layout storage is intercepted during this smoke so the test
does not overwrite the user's layout; auth, catalog, PTY, WS and assets are live.

Deploy both frontend and native binaries with
`npm run deploy:service -- --frontend --restart-native-pty`. Verify loaded binary
hashes, authenticated effective backend and HTTPS reachability after restart.
The deploy script retains its rollback behavior. If the service is unreachable,
restore the previous binaries/assets and restart immediately. Do not switch the
user's backend choice as an implicit workaround.
