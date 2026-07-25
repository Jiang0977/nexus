# AGENTS.md

## Project Knowledge Precedence

When repository facts conflict with agent or external memory, use this order:

1. Current source code and tests.
2. This file for workflow, safety, verification, and deployment rules.
3. `docs/ARCHITECTURE.md` and `docs/code.md`.
4. Current documents under `docs/designs/`.
5. `TODOS.md`, `docs/CURRENT-ROADMAP.md`, and `docs/ROADMAP.md`.
6. Agent memory or external conversation context.

Do not treat `~/.codex/memories/` as an authoritative project source.

## Deployment Constraints

- Deployments require a service restart: restart the **nexus** service after deploying code changes.
- After restart, verify the service is accessible. If the service becomes unreachable after deployment, **rollback** the deployed code to the previous version immediately.

## Local Auth Smoke Testing

- Do not ask the user to paste the login password for routine browser smoke tests.
- Preferred test entrypoint: `npm run smoke:login-upload`.
- The script reads `.context/secrets/e2e.env` by default. This directory is git-ignored.
- Required local secret format: `NEXUS_E2E_PASSWORD=<current Nexus login password>`.
- Optional overrides: `NEXUS_E2E_BASE_URL`, `NEXUS_E2E_SESSION`, `NEXUS_E2E_WINDOW`, `NEXUS_E2E_SECRET_FILE`.
- The smoke test logs in through the real login page, uploads a temporary 1px image, verifies the returned path is sent through the terminal WebSocket, and cleans up its temporary upload file.

## Preferred Verification Entry Points

- Repository-wide verification entrypoint: `npm run check`.
- If the change only touches frontend source, use `npm run build:frontend` at minimum because production serves `frontend/dist/`, not `frontend/src/`.
- If the change only touches frontend types, `npm run typecheck:frontend` is the narrowest typed check.
- If the change only touches Rust runtime code, use `npm run test:rust`.
- For CI parity on Rust changes, also run `cargo fmt --manifest-path rust-runtime/Cargo.toml --check` and `cargo clippy --manifest-path rust-runtime/Cargo.toml --all-targets --all-features -- -D warnings`.
- If the change only touches Node/server scripts or tests, use `npm run test:node`.
- If the change touches browser terminal regression behavior, add `npm run test:browser`.
- If the change touches installed runtime binaries, add `npm run build:rust-runtimes`; for server or Codex HOME binary changes use `npm run build:rust-server` or `npm run build:rust-codex-home`; for setup/installer changes also run `npm run build:rust-setup`.

## Deployment Notes

- Preferred deployment entrypoint: `npm run deploy:service`.
- If frontend source changed, deploy with `npm run deploy:service -- --frontend`.
- If native supervisor binaries must be refreshed and interrupting native sessions is acceptable, deploy with `npm run deploy:service -- --restart-native-pty`.
- `npm run restart:service` restarts `nexus` and checks `/api/version`, accepting HTTP 200 or 401; override with `NEXUS_HEALTHCHECK_URL`, `NEXUS_HOST`, or `PORT` when needed.
- `nexus.service` restart does not refresh already-running tmux/Codex channels under `nexus-tmux.service`; when verifying deployment-sensitive Codex behavior, verify with a newly created channel or explicitly account for existing runtime state.
- `start.sh` and `scripts/nexus-tmux-service.sh` both rely on `scripts/nexus-paths.sh` to repair agent CLI `PATH`; keep that path in scope for startup or Codex/Claude launcher changes.
- Do not use `pm2` as an operations path; current service management is via systemd scripts and `npm run deploy:service` / `npm run restart:service`.
- Native backend remains opt-in/staging; do not treat `native` as the default production path unless the docs and config explicitly say so.
