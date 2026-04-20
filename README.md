# Nexus

### Self-hosted mobile workbench for local coding agents.

[![Rust](https://img.shields.io/badge/rust-stable-orange?style=flat-square)](https://www.rust-lang.org/)
[![License: GPL v3](https://img.shields.io/badge/license-GPL%20v3%20%2F%20Commercial-blue?style=flat-square)](LICENSE.md)
[![GitHub stars](https://img.shields.io/github/stars/Jiang0977/nexus?style=flat-square)](https://github.com/Jiang0977/nexus/stargazers)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen?style=flat-square)](CONTRIBUTING.md)

[🇨🇳 中文](README_CN.md)

---

### Showcase

<p>
  <video src="https://github.com/user-attachments/assets/083495f7-d840-4733-9307-eaa815c2756f" width="45%" controls muted align="center">
    Your browser does not support the video tag.
  </video>
</p>

---

## Highlights

| | |
|---|---|
| **AI on the go** | Your time is fragmented. Your AI shouldn't be. Command your local coding agents from your phone — commuting, in a meeting, or away from your desk. |
| **Built for touch** | Not a desktop terminal shoehorned onto mobile. Swipe between windows, pinch-to-zoom, configurable toolbar — purpose-built for fingers. |
| **Full context, always** | Your agent runtime runs on your machine, in your tmux sessions — your full codebase, your history, your preferences. Not a cloud chat that forgets everything. |
| **Fire and forget** | Give the instruction, close your phone. Your agents keep running. Open later — everything's exactly where you left it. |

---

## Why Nexus?

|                          | Anthropic Remote Control | Happy Coder | Omnara  | **Nexus** |
|--------------------------|:---:|:---:|:---:|:---:|
| Self-hosted              | ❌ | ❌ | ⚠️ | ✅ |
| No subscription needed   | ❌ ($100+/mo) | ✅ | ❌ ($9/mo) | ✅ |
| Data stays on your infra | ❌ | ❌ | ❌ | ✅ |
| Real terminal (xterm)    | ❌ | ❌ | ❌ | ✅ |
| Project & channel management | ❌ | ⚠️ | ⚠️ | ✅ |
| Fire & forget            | ⚠️ (10min timeout) | ✅ (via relay) | ✅ (via relay) | ✅ (pure tmux) |
| PWA / installable        | ❌ | ✅ (native app) | ✅ (native app) | ✅ |
| Open source              | ❌ | ⚠️ partial | ✅ | ✅ |

> **Project & channel management:** Organize work by directory-based projects, each with multiple channel-like sessions — switch between them instantly, like Slack channels for your terminal.

---

## Features

- 🔌 **WebSocket ↔ tmux bridge** — one PTY per window, real-time bidirectional I/O
- 📱 **Mobile-first terminal** — xterm.js, swipe navigation, pinch-to-zoom, configurable soft toolbar
- 🤖 **Async task runner** — fire-and-forget agent tasks via `/api/tasks`, SSE streaming, and Telegram bridge
- 📂 **File browser** — browse, edit, upload workspace files (sort by name / modified / size)
- 🗂️ **Project & channel management** — directory-based projects, each with channel-like sessions (like Slack channels for your terminal)
- 🔀 **Multi-session** — switch tmux sessions instantly
- 🎨 **PWA** — installable, dark / light themes
- ⚡ **Zero overhead** — direct WebSocket pipe, no SSH

---

## Quick Start

```bash
git clone https://github.com/Jiang0977/nexus.git && cd nexus
cp .env.example .env
./setup.sh
# Open http://localhost:59000 on any device 🚀
```

`./setup.sh` provisions `.env`, installs `systemd --user` units, and starts both `nexus` and `nexus-tmux`.

If you prefer a direct foreground start:

```bash
bash start.sh
```

Important:

- Runtime stays Rust-first: Rust serves `frontend/dist/` directly.
- The repo now carries a maintainable frontend source tree under `frontend/src/`.
- Frontend source changes require rebuilding `frontend/dist/` from the `frontend/` toolchain.
- `bash start.sh` only builds Rust binaries; it does not rebuild frontend assets.
- Repository-wide verification now lives behind `npm run check`.
- GitHub Actions CI runs the same `npm run check` contract on every push / PR.
- Default runtime values are unified in `.env.example` and Rust config: `PORT=59000`, `GITHUB_REPO=Jiang0977/nexus`.

> Full setup guide including session profile config, systemd, and mobile access: **[QUICKSTART.md →](docs/QUICKSTART.md)**

---

## Install With An AI Assistant

If you're an AI assistant helping a user install Nexus, follow this path:

1. Clone this repo and `cd` into it
2. Run `./setup.sh`
3. Verify: `systemctl --user status nexus` shows the service running
4. Open `http://localhost:59000`

Prerequisites: Rust toolchain (`cargo`), tmux, Linux / WSL2. `setup.sh` expects `systemd --user`; direct `bash start.sh` does not.
Default login password: `nexus123` (user can change it in `.env` after setup).

---

## Deployment

Expose securely without port forwarding via [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) or [Tailscale](https://tailscale.com/).

For production updates, restart, verification, and rollback, use **[DEPLOYMENT-RUNBOOK.md](docs/DEPLOYMENT-RUNBOOK.md)** as the single source of truth.

For local maintenance before opening a PR or deploying:

```bash
npm run check
```

---

## Requirements

| Dependency | Version | Note |
|---|---|---|
| Rust | stable toolchain | required to build `nexus-server`, runtimes, and `nexus-setup` |
| Node.js + npm | recent LTS | required only for frontend source development and rebuilding `frontend/dist` |
| tmux | any recent | |
| systemd user services | available | required by `./setup.sh`; optional for direct `bash start.sh` |
| OS | Linux / WSL2 | |

---

## Security

Nexus is a **single-user, self-hosted tool** — not a multi-tenant platform.

- 🔒 bcrypt (12 rounds) password hash + JWT (30d)
- ⚠️ WebSocket token passed via query string — enable TLS in production
- 🛡️ Run behind firewall, VPN, or tunnel — do not expose directly to the internet

---

## Documentation

| Doc | |
|---|---|
| [QUICKSTART.md](docs/QUICKSTART.md) | Step-by-step setup guide |
| [DEPLOYMENT-RUNBOOK.md](docs/DEPLOYMENT-RUNBOOK.md) | Production update, restart, verification, and rollback runbook |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | System design |
| [ROADMAP.md](docs/ROADMAP.md) | What's next |
| [CURRENT-ROADMAP.md](docs/CURRENT-ROADMAP.md) | Current execution status and doc drift notes |
| [📖 The story behind Nexus](docs/story.md) | Why this was built |

---

## Community

<p>
  <img src="https://github.com/user-attachments/assets/6960ca95-f26d-484b-aa66-56b5315e39d3" width="225" />
</p>

---

## Contributing

PRs and issues welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for local dev setup, commit standards, and good first issue ideas.

---

## License

Dual-licensed: **[GPL v3](LICENSE.md)** for open-source use · **Commercial license** available for proprietary / SaaS use — contact [librae8226](https://github.com/librae8226) or [faywong](https://github.com/faywong)

---

*Built for serious remote AI work.*
