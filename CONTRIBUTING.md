# Contributing to Nexus

This is an independently maintained GPL-3.0-or-later derivative of
[Nexus4CC](https://github.com/librae8226/nexus4cc). Contributions must be compatible
with that license; retain upstream and third-party copyright notices.

## Local setup

Use Linux/WSL2 with Rust stable, a C/C++ compiler, CMake, pkg-config, tmux, zsh,
Python 3, curl and Node.js 22.13+ (or a newer supported LTS).

```bash
git clone https://github.com/Jiang0977/nexus.git
cd nexus
npm ci
npm --prefix frontend ci
npx playwright install --with-deps chromium
./setup.sh --configure-only
bash start.sh
```

Save the generated password and open http://127.0.0.1:59000. This setup does not
install system services. Never commit local `.env`, `data/`, `.context/` or credentials.
The Rust server serves `frontend/dist/`, so rebuild it after frontend changes:

```bash
npm run build:frontend
```

## Before submitting

```bash
npm run check
cargo fmt --manifest-path rust-runtime/Cargo.toml --check
cargo clippy --manifest-path rust-runtime/Cargo.toml --all-targets --all-features -- -D warnings
```

Keep changes scoped, include regression coverage for behavioral fixes, and update
user documentation when commands or behavior change. Browser terminal changes
also need `npm run test:browser` and a manual check of the affected interaction.
Tmux is the default stable backend; native remains opt-in/staging.

Use commit subjects such as `fix(setup): build all required runtime binaries`.
Do not add co-author identities unless they accurately describe the contribution.
For personal email privacy, use your GitHub-provided noreply address before committing.

## Issues and security

Report ordinary bugs through [Issues](https://github.com/Jiang0977/nexus/issues),
including version, OS, backend and a minimal reproduction. Replace real projects,
paths, addresses and terminal content with synthetic examples. Do not upload raw
configuration files or secrets. Report vulnerabilities privately as described in
[SECURITY.md](SECURITY.md).

## Release maintenance

Read [docs/RELEASING.md](docs/RELEASING.md) for versioning, checks, source/binary
packaging, checksum verification and publishing. Historical verification documents
record one environment at one date; they are not a promise of universal compatibility.
