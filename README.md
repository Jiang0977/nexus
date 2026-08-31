# Nexus

Self-hosted workbench for running local coding agents from desktop, mobile, and browser terminals.

[![Rust](https://img.shields.io/badge/rust-stable-orange?style=flat-square)](https://www.rust-lang.org/)
[![License: GPL v3 / Commercial](https://img.shields.io/badge/license-GPL%20v3%20%2F%20Commercial-blue?style=flat-square)](LICENSE.md)
[![GitHub stars](https://img.shields.io/github/stars/Jiang0977/nexus?style=flat-square)](https://github.com/Jiang0977/nexus/stargazers)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen?style=flat-square)](CONTRIBUTING.md)

[Chinese](README_CN.md)

## What It Is

Nexus is a single-user, self-hosted control surface for local AI coding agents. It runs on your own machine, serves a PWA/browser UI, and lets you keep terminal-backed agent sessions alive after you close the browser.

Current runtime shape:

```text
Browser / PWA
  <-> Rust server (HTTP / WebSocket)
  <-> Rust child runtimes
  <-> session backend
      - tmux: default, stable path
      - native: opt-in Rust PTY backend, still converging
```

## Features

- Browser terminal built on xterm.js with mobile touch controls, scrollback, upload, and configurable toolbar.
- Project and channel management: directory-based projects, each with multiple terminal channels.
- Desktop split view: single / vertical / horizontal / 2x2 / 3x3 terminal panes.
- Async task runner via `/api/tasks`, SSE streaming, and Telegram bridge.
- File browser for workspace browsing, editing, upload, rename, move, copy, and delete.
- Authenticated prompt library for saving, editing, searching, copying, and inserting reusable prompts into the active terminal without auto-submit.
- Codex and Claude profile launchers, including Codex history/resume flows.
- PWA support with dark/light themes.
- Rust-first runtime: `nexus-server` serves `frontend/dist/` directly.

## Terminal Backends

| Backend | Status | Notes |
|---|---|---|
| `tmux` | Default / stable | Production path. Sessions survive browser and `nexus` service restarts through `nexus-tmux.service`. |
| `native` | Opt-in / staging | Rust PTY backend with `nexus-native-pty-supervisor`, SQLite-backed native session registry, bounded scrollback, and `nexus-native-session` CLI attach. It is not the default production path yet. |

Switching backend:

- UI: Settings -> Terminal Backend -> save -> restart `nexus`.
- Config: set `NEXUS_SESSION_BACKEND=native` in `.env`, or write `data/session-backend.json`.
- Native mode also needs `nexus-native-pty.service` running.
- Terminal WebSockets use a 10-second server heartbeat by default; set a positive `NEXUS_WS_HEARTBEAT_MS` value in `.env` only when an operator needs a different interval.

Attach to native sessions from another terminal:

```bash
nexus-native-session list
nexus-native-session attach <project> <channel-index>
```

## Quick Start

```bash
git clone https://github.com/Jiang0977/nexus.git
cd nexus
cp .env.example .env
./setup.sh
```

Open:

```text
http://localhost:59000
```

`./setup.sh` provisions `.env`, installs `systemd --user` units, installs the native session CLI symlink, and starts:

- `nexus.service`
- `nexus-tmux.service`
- `nexus-native-pty.service` (idle unless native backend is enabled)

Direct foreground start:

```bash
bash start.sh
```

Full setup guide: [docs/QUICKSTART.md](docs/QUICKSTART.md)

## Development

Important constraints:

- Runtime serves `frontend/dist/`; `frontend/src/` is source, not the production entrypoint.
- Frontend source changes require rebuilding `frontend/dist/`.
- Rust release binaries are the deployment artifacts.
- Repository-wide verification is `npm run check`.

Useful commands:

```bash
npm run check
npm run build:frontend
npm run build:rust-runtimes
npm run smoke:login-upload
```

The login/upload smoke reads `.context/secrets/e2e.env`:

```text
NEXUS_E2E_PASSWORD=<current Nexus login password>
```

## Deployment

Use [docs/DEPLOYMENT-RUNBOOK.md](docs/DEPLOYMENT-RUNBOOK.md) as the deployment source of truth.

Short path:

```bash
npm run deploy:service
```

If frontend source changed:

```bash
npm run deploy:service -- --frontend
```

If native sessions can be interrupted and the native supervisor binary must be refreshed:

```bash
npm run deploy:service -- --restart-native-pty
```

Expose Nexus behind a trusted tunnel or private network such as Cloudflare Tunnel or Tailscale. Do not expose it directly to the public internet.

## Requirements

| Dependency | Note |
|---|---|
| Rust stable toolchain | Builds `nexus-server`, child runtimes, setup, and native PTY binaries. |
| tmux | Required for the default backend. |
| systemd user services | Required by `./setup.sh`; direct `bash start.sh` can run without it. |
| Node.js + npm | Needed for frontend development, tests, and `npm run check`. |
| Linux / WSL2 | Primary supported deployment target. Native backend is still being hardened for broader platform support. |
| Claude / Codex CLI | Optional, needed only for launching those agents inside Nexus. |

## Security

Nexus is a single-user tool, not a multi-tenant platform.

- bcrypt password hash + 30-day JWT.
- WebSocket token is passed through the query string; use TLS in production.
- Run behind a firewall, VPN, or tunnel.
- Treat any browser terminal as local shell access to `WORKSPACE_ROOT`.

## Documentation

| Doc | Purpose |
|---|---|
| [QUICKSTART.md](docs/QUICKSTART.md) | Setup, config, profiles, native backend notes, smoke testing. |
| [DEPLOYMENT-RUNBOOK.md](docs/DEPLOYMENT-RUNBOOK.md) | Production update, restart, verification, rollback. |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Current runtime architecture and module boundaries. |
| [CURRENT-ROADMAP.md](docs/CURRENT-ROADMAP.md) | Current execution status and documentation authority order. |
| [NORTH-STAR.md](docs/NORTH-STAR.md) | Product boundaries and non-goals. |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Local development and contribution rules. |

## Contributing

PRs and issues are welcome. Keep changes scoped, run `npm run check`, and update docs when runtime behavior changes.

## License

Dual-licensed: [GPL v3](LICENSE.md) for open-source use, commercial license available for proprietary / SaaS use.
