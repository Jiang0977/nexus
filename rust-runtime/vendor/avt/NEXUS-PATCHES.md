# Nexus compatibility patch

Base: asciinema/avt 0.18.0, Apache-2.0. Upstream source and tests are retained.

The native PTY stream remains raw. A checkpoint must therefore reproduce the
same state as the pinned browser xterm 6.0.0, not merely a similar screenshot.

Local differences:

- Use the same Unicode 11 width table as the browser's pinned official
  `@xterm/addon-unicode11` 0.9.0, generated from its installed source. Run
  `node scripts/generate-native-unicode-width.mjs --check` from the repo root.
- Preserve combining characters in cells, copies, reflow and dumps.
- Include the empty color-space slot in colon-form truecolor SGR, as required
  by xterm; omitting it shifts RGB components on checkpoint restore.
- Repaint the last printed cell at the end of a checkpoint to restore Unicode
  joining and REP continuation, which cursor/attribute serialization alone loses.
- Preserve soft-wrap flags during DCH, matching xterm and keeping insert-mode
  checkpoint repaint lossless. Retain the property-test regression seeds.
- Insert wide characters by their cell width, rather than shifting only one cell.
- Bound combining text to 1 KiB per cell and expose recovery overflow to the
  wrapper, which rejects an unsafe checkpoint instead of silently truncating it.
- Expose `dump_screen()` so Nexus can append its bounded incremental parser
  prefix, including OSC payloads that upstream's parser does not retain.
- Remove unavailable packaged benchmark targets and their unused dependency.

The wrapper in `src/native_terminal_state.rs` owns input modes, safe resource
limits and transient escape-prefix handling. Do not use application names or
titles to select terminal behavior.

Before replacing this fork, run its own library tests, the Nexus Rust tests and
`tests/nativeTerminalRestore.test.js` against fresh Chrome/xterm instances. Keep
the Unicode table parity check and combining-character continuation test. Do not
upgrade xterm and avt independently without this cross-engine acceptance.
