# Contributing to Nexus

Thanks for contributing.

## Local Development

**Prerequisites:** Rust stable toolchain, tmux, Linux / WSL2. For frontend work: Node.js + npm.

```bash
git clone https://github.com/Jiang0977/nexus.git && cd nexus
cp .env.example .env
cargo build --manifest-path rust-runtime/Cargo.toml
bash start.sh
```

Open `http://localhost:59000`.

Important constraints:

- Runtime still serves `frontend/dist/` directly from Rust.
- Frontend source lives under `frontend/src/`; rebuild `frontend/dist/` after frontend changes.
- Do not bring PM2 back as the default runtime path.

For frontend changes:

```bash
cd frontend
npm install
npm run build
```

## Before You Submit

1. Read [NORTH-STAR.md](NORTH-STAR.md).
2. Run the relevant checks, at minimum `cargo test --manifest-path rust-runtime/Cargo.toml`.
3. Manually verify the affected browser flow when UI or startup behavior changes.
4. Keep scope to one logical change.

## Commit Message Standard

```text
type(scope): imperative subject <= 72 chars

Body (optional): explain why, not what.
Bug fixes: explain root cause.

Co-Authored-By: Claude <noreply@anthropic.com>
```

Types: `feat` `fix` `docs` `refactor` `test` `chore` `style`

## Good First Issues

- Rust runtime tests and startup-path coverage
- Docs cleanup in `README.md`, `docs/ARCHITECTURE.md`, `docs/DEPLOYMENT-RUNBOOK.md`
- systemd / tmux operational fixes
- Bug reports with a clear reproduction path

## Questions?

Open an issue or reach out via WeChat (`librae8226`).
