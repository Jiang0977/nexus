Build Rust release binaries, restart the systemd user service, and verify status.

```bash
cargo build --manifest-path rust-runtime/Cargo.toml --release --bin nexus-server --bin nexus-pty-runtime --bin nexus-window-launch-runtime --bin nexus-session-runtime && systemctl --user restart nexus && systemctl --user status nexus --no-pager
```
