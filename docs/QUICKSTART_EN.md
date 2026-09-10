# From installation to your first agent session

[简体中文](QUICKSTART.md) · [Home](../README.md)

## 1. Prerequisites

Use a regular Linux account. Ubuntu 24.04+ is recommended; WSL2 needs systemd
([Microsoft setup](https://learn.microsoft.com/windows/wsl/systemd)). The binary
archive requires x86_64 and glibc 2.39+. macOS, Windows-native and Alpine/musl
are not supported by the binary release.

```bash
sudo apt update
sudo apt install -y tmux zsh python3 curl git ca-certificates
uname -m
getconf GNU_LIBC_VERSION
systemctl --user show-environment >/dev/null
```

The last command must succeed: checking only `systemctl --version` does not
verify a working user service manager. Without it, use foreground mode below.
Install and authenticate Claude/Codex separately before launching them in Nexus.
Nexus does not include an AI subscription, API credits or the agent executables.

## 2. Install a release

Download `nexus-4.5.0-linux-x86_64.tar.gz` and `SHA256SUMS` from
[Releases](https://github.com/Jiang0977/nexus/releases). In the download directory:

```bash
sha256sum --ignore-missing -c SHA256SUMS
mkdir -p "$HOME/.local/lib/nexus"
tar -xzf nexus-4.5.0-linux-x86_64.tar.gz -C "$HOME/.local/lib/nexus" --strip-components=1
cd "$HOME/.local/lib/nexus"
./setup.sh
```

Continue only if checksum verification succeeds. These are fresh-install steps;
see the runbook for upgrades. No Rust or Node toolchain is needed for this archive.
Setup creates `.env` and three systemd user services. Save the displayed random
password: there is no shared default. Keep the install directory in place.
If setup fails after displaying credentials, retain the password before retrying.
Existing custom credentials are preserved on a normal rerun.

## 3. Build from source or run in the foreground

Install [Rust stable](https://www.rust-lang.org/tools/install) first, then:

```bash
sudo apt install -y build-essential cmake pkg-config
git clone https://github.com/Jiang0977/nexus.git
cd nexus
./setup.sh
```

Source setup builds all Rust binaries; the first build can take several minutes.
`frontend/dist/` is checked in, so Node is not required just to run the service.
For foreground mode without systemd:

```bash
./setup.sh --configure-only
bash start.sh
```

Configure-only generates secure credentials without installing services. Ctrl+C
stops the foreground server. This mode does not provide the separate systemd
service restart guarantees; native mode also needs a running supervisor.

## 4. Log in and create a project

1. Open **http://127.0.0.1:59000** on the installation machine and enter the
   generated password. Agent setup can be deferred until your CLI is ready.
2. Set `WORKSPACE_ROOT` in the installation's `.env` to an existing directory,
   for example `/home/demo/projects`. The Nexus account must be able to access it.
3. After configuration changes, run `systemctl --user restart nexus`.
4. Add a project from the project list and select a directory under the workspace.
5. Add a Bash/shell channel first. Run `pwd` to verify the selected project.
6. Add a Claude or Codex channel once its CLI is installed and authenticated, or
   configured with a valid provider profile.

A project maps to a directory; a channel is a terminal session in that project.
Closing a tab does not delete its channel. Desktop layout controls create split
panes whose channels you can choose independently. Prompt insertion fills the
terminal without automatically pressing Enter. Deleting a channel ends its process.
Changing a profile does not restart an already running terminal.

## 5. Agent authentication and profiles

First confirm `claude --version` or `codex --version` works in a host terminal,
then finish the agent's own login and verify a simple request. Nexus attempts to
find CLIs installed through NVM/Volta, but does not install missing executables.

Manage profiles in the agent settings UI. Claude profiles are stored under
`data/configs/`; Codex profiles under `data/codex-configs/`. These files may contain
API keys. Use provider-documented endpoints, model IDs and credentials; never
publish profile files. Codex history comes from local CLI session records; an
empty history panel is normal when no records exist.

**Permissions:** terminal commands run as the Nexus OS account. Claude/Codex
launchers bypass permission prompts, and Codex bypasses its sandbox.
`WORKSPACE_ROOT` is not shell confinement. Read [SECURITY.md](../SECURITY.md).

## 6. Connect from a phone

`127.0.0.1` on your phone points to the phone, not your computer. Use a private
VPN or an authenticated HTTPS reverse proxy to reach the computer.

For Tailscale, connect both devices to your private tailnet and follow
[Tailscale Serve](https://tailscale.com/kb/1242/tailscale-serve) to proxy
`http://127.0.0.1:59000` over HTTPS inside the tailnet. Do not enable public Funnel.
Open the HTTPS address displayed by Serve on your phone, then log in to Nexus.
Android browsers can install the PWA; Safari on iPhone offers Add to Home Screen.
The computer must remain online and awake. PWA installation is not offline terminal access.

Other proxies must support WebSocket upgrades and access control. Redact URL
query tokens in logs; a public tunnel alone is not an authentication policy.

## 7. Password reset, status and troubleshooting

From the installation directory, rotate the password and JWT secret:

```bash
./setup.sh --configure-only --reset-password
systemctl --user restart nexus
```

Save the new password. Existing login tokens become invalid after restart.
For foreground mode, stop and restart `bash start.sh` instead.

```bash
systemctl --user status nexus nexus-tmux nexus-native-pty --no-pager
journalctl --user -u nexus -n 50 --no-pager
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:59000/api/version
```

An unauthenticated `/api/version` response of **401** is expected; the home page
should return 200.

| Problem | Next step |
|---|---|
| `JWT_SECRET must be set` | Run `./setup.sh --configure-only`; the empty example is not a working credential file |
| `Failed to connect to bus` | Enable systemd user services or use foreground mode |
| `GLIBC_x.y not found` | Use a supported OS or build on the target system |
| Missing cargo | Install Rust for source builds; binary archives do not need it |
| Missing agent CLI | Verify the host CLI and service PATH; save work before restarting tmux |
| Frontend edits not visible | Install frontend dependencies, rebuild dist and deploy |
| Phone cannot connect | Check the host is online, VPN/proxy configuration and the host HTTPS URL |

## 8. Development checks

Use Node.js 22.13+ (or a newer supported LTS), npm, Rust stable and the runtime dependencies.

```bash
npm ci
npm --prefix frontend ci
npx playwright install --with-deps chromium
npm run check
cargo fmt --manifest-path rust-runtime/Cargo.toml --check
cargo clippy --manifest-path rust-runtime/Cargo.toml --all-targets --all-features -- -D warnings
```

`npm run check` runs Rust/Node tests, frontend build and committed-bundle drift
checks. Intentional frontend edits require rebuilding and including the new dist.

For a real login/upload smoke, create local `.context/secrets/e2e.env` containing
`NEXUS_E2E_PASSWORD=<current password>` with mode 600, then run
`npm run smoke:login-upload`. This uploads a temporary CSV, sends its path through
the terminal WebSocket and cleans up. Use a channel where test input is acceptable.
Override `NEXUS_E2E_BASE_URL`, `NEXUS_E2E_SESSION` and `NEXUS_E2E_WINDOW` as needed.
Never put the password in an issue or commit.

## 9. Optional native backend

Tmux remains the default stable path. Native is opt-in/staging. Save your work,
select Terminal Backend → native in settings, save and restart Nexus. Check
`nexus-native-pty.service` is running. An explicit `.env` value for
`NEXUS_SESSION_BACKEND` takes precedence over the UI setting.

```bash
systemctl --user restart nexus
systemctl --user status nexus-native-pty --no-pager
nexus-native-session list
nexus-native-session attach <project> <channel-index>
```

Add `~/.local/bin` to PATH to use the CLI. To revert, select tmux, remove conflicting
environment overrides and restart Nexus. Existing native sessions are not converted
to tmux sessions. Restarting the native supervisor interrupts its running processes.

Continue with the [update, backup, rollback and uninstall guide](DEPLOYMENT-RUNBOOK.md).
