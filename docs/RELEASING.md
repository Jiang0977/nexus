# Release procedure

The supported binary artifact is Linux x86_64 with glibc 2.39+ (Ubuntu 24.04).
Build on Ubuntu 24.04 to avoid silently raising the minimum libc requirement.
Other architectures require their own build and runtime verification before
being advertised. Releases are manual and require maintainer authorization.

1. Update root/frontend package versions and locks, CHANGELOG.md and tutorial filenames.
2. Run `npm ci`, `npm --prefix frontend ci` and install Playwright Chromium.
3. Run `npm run check`, Rust fmt and clippy; review the final diff and run
   `gitleaks git . --redact --log-opts=--all` (Gitleaks 8.30.1 or compatible).
   `.gitleaks.toml` documents two narrow false-positive patterns; do not add broad exclusions.
4. Commit the exact reviewed tree. Run `npm run package:release` from that clean tree.
   Use `-- --allow-dirty` only for local rehearsal; never publish its outputs.
5. The packager builds all Rust binaries with maintainer paths remapped, includes
   frontend assets, runtime scripts, full GPL text and dependency notices. It creates:
   - `nexus-VERSION-linux-x86_64.tar.gz`
   - `nexus-VERSION-source.tar.gz` (project, vendored Rust dependency sources and frontend packages)
   - `SHA256SUMS`
6. Extract into a fresh temporary directory. Run `./setup.sh --configure-only`,
   verify mode 0600 and random credentials, start the server on an isolated port,
   log in, create a synthetic shell channel, verify WebSocket input/reconnect and
   stop/clean up. Run `node scripts/release-smoke.mjs release/nexus-VERSION-linux-x86_64.tar.gz`
   for this check (optionally set NEXUS_BROWSER_EXECUTABLE). No test may attach to
   a personal production session.
7. Test service installation through isolated systemd fixtures; also run a real
   user-service install in a disposable Linux/WSL environment before widening platform claims.
8. Verify archive file lists contain no `.git`, `.env`, `data/`, logs or local
   work artifacts. Scan binary strings and source/history for personal information.
9. Create/push a release tag at the reviewed commit. Upload both archives and
   SHA256SUMS to a GitHub release. Include the supported OS/backend limitations.
10. Download the published artifacts into a new directory, verify their checksums
    and confirm tag/commit parity. Public releases must be accessible without authentication.

The source archive can build Rust offline with
`cargo build --offline --locked --manifest-path rust-runtime/Cargo.toml --release --bins`.
Rebuild the frontend using its included packages with `npm --prefix frontend run build`.
Root Node test dependencies can be installed using `npm ci` when running the full
contributor test suite. Keep source and binary archives together on the release.
