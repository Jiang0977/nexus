# Update, backup, rollback and uninstall

适用于 4.5.0。默认安装方式是 `systemd --user`；现有系统级安装仍受支持。
The default installation uses systemd user services; existing system services
remain supported. Run commands from the actual install directory.

## Identify the installation / 确认安装位置

```bash
systemctl --user show nexus.service -p WorkingDirectory --value
systemctl show nexus.service -p WorkingDirectory --value
```

Use the scope that contains your installation. Restart/deploy scripts detect it
automatically. If both exist, choose explicitly with `NEXUS_SERVICE_SCOPE=user`
or `system`. System scope uses non-interactive sudo and requires suitable privileges.
No automatic switch from a user installation to a system installation is performed.

`.env` and `data/` belong to the runtime directory. If `NEXUS_DATA_DIR` is set,
back up that directory instead. The source checkout may be separate from runtime.
Never assume that editing a checkout immediately updates a separately installed service.

## Back up / 备份

Before an update, save agent work and make a private backup of the installation,
including `.env`, `data/`, executables, scripts and frontend. Use a directory owned
by you with mode 700. Backups contain credentials, prompts, files and session history.
For a consistent native SQLite backup, stop native activity/supervisor first or
use SQLite's backup mechanism. Copying a live database alone is not sufficient.
Running shell processes cannot be recovered just by restoring a filesystem backup.

For a stopped installation at the default location:

```bash
umask 077
mkdir -p "$HOME/.local/state/nexus-backups"
tar -czf "$HOME/.local/state/nexus-backups/nexus-$(date +%Y%m%d-%H%M%S).tar.gz" \
  -C "$HOME/.local/lib" nexus
```

For source installations or external data paths, adjust the backup scope explicitly.
Do not publish or attach the archive to an issue.

## Update a binary installation / 更新安装包

1. Save all running work. Updating the native supervisor requires interrupting its sessions.
2. Download the new archive and SHA256SUMS; verify them with `sha256sum --ignore-missing -c SHA256SUMS`.
3. Back up the installation. Extract the new archive into a separate staging directory
   and review its VERSION and release notes before replacing files.
4. Stop Nexus and both session services (this ends terminal processes):

   ```bash
   systemctl --user stop nexus nexus-native-pty nexus-tmux
   ```

5. Extract the verified archive into the existing installation with `--strip-components=1`.
   Binary packages exclude `.env` and runtime `data/`, so those remain yours. Remove
   obsolete frontend hashed assets by replacing `frontend/dist/` with the staged
   version instead of merging files when updating between releases.
6. In the installation directory run `./setup.sh`. It retains custom credentials,
   refreshes user units and starts services. For an existing system installation,
   retain your configured units and use the system-scope restart path instead.
7. Verify the service and a newly created shell/agent channel as described below.

If the updated service is unreachable, stop it and immediately restore the full
pre-update installation, then start the previous services and recheck accessibility.
Do not overwrite runtime data with an older copy unless recovery requires it.

## Update from source / 源码更新

Install development dependencies and verify the candidate commit first:

```bash
npm ci
npm --prefix frontend ci
npx playwright install --with-deps chromium
npm run check
cargo fmt --manifest-path rust-runtime/Cargo.toml --check
cargo clippy --manifest-path rust-runtime/Cargo.toml --all-targets --all-features -- -D warnings
```

Deploy from the checkout:

```bash
npm run deploy:service -- --frontend
```

For explicit service scope:

```bash
NEXUS_SERVICE_SCOPE=user npm run deploy:service -- --frontend
```

The script builds release binaries, discovers the runtime WorkingDirectory (or
uses `NEXUS_INSTALL_ROOT`), snapshots existing binaries/frontend, syncs the new
binaries/frontend and restarts Nexus. A failed build/sync/restart/healthcheck
restores these artifacts and attempts to restart the previous version.

**Rollback boundary:** the helper snapshots binaries and the independent install
tree's frontend. It does not update or roll back `.env`, data, shell scripts or
systemd units. If those source files changed, include them in your full backup
and update the install tree from the same revision before restarting. A source
checkout used directly as runtime already has the new scripts after checkout.
For an independent tree, a complete verified release archive is the simplest
way to keep scripts and binaries together.

Frontend files are staged and switched with two renames, with a brief interval
where `dist/` is absent; they are never served from a half-copied directory.
Release binary replacement uses an atomic same-directory rename.

Native supervisor processes are preserved by default. If you accept interruption
and need the new supervisor binary loaded, use:

```bash
npm run deploy:service -- --frontend --restart-native-pty
```

Nexus restarts do not refresh already running agent sessions. Validate launcher
changes using a new channel. Never use PM2 for this Rust runtime.

## Verify / 验证

```bash
systemctl --user status nexus nexus-tmux nexus-native-pty --no-pager
journalctl --user -u nexus -n 30 --no-pager
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:59000/
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:59000/api/version
```

Expected: active services, home page 200, unauthenticated version endpoint 401.
For system installations use `sudo systemctl` and `sudo journalctl` instead.
Check the real HTTPS entrypoint separately. Log in, create a test shell channel,
verify input/output, refresh and reconnect; close that test channel afterwards.
For frontend changes compare served assets with the release being installed.
The restart helper accepts version responses 200/401 and supports
`NEXUS_HEALTHCHECK_URL`, `NEXUS_HOST` and `PORT` overrides for nondefault endpoints.

For optional native acceptance, build all binaries and run `npm run smoke:native`.
This requires Playwright Chromium and Node 22.13+. Live native testing additionally
requires `NEXUS_E2E_BASE_URL`, the local login secret and
`NEXUS_ACCEPTANCE_NATIVE_DB` pointing to the actual live SQLite registry:

```bash
NEXUS_E2E_BASE_URL=https://nexus.example.com \
NEXUS_ACCEPTANCE_NATIVE_DB=/path/to/data/native-sessions/session.db \
npm run smoke:native -- --live
```

Replace the examples with your own paths. `NEXUS_BROWSER_EXECUTABLE` optionally
selects an installed browser. Live acceptance creates temporary projects and
uploads, then cleans them up; it is not a read-only healthcheck.

## Uninstall / 卸载

First save work: stopping tmux or the native supervisor ends terminal processes.
For the default user installation:

```bash
systemctl --user disable --now nexus nexus-native-pty nexus-tmux
rm -f "$HOME/.config/systemd/user/nexus.service" \
  "$HOME/.config/systemd/user/nexus-tmux.service" \
  "$HOME/.config/systemd/user/nexus-native-pty.service"
systemctl --user daemon-reload
rm -f "$HOME/.local/bin/nexus-native-session"
```

Keep the installation/data until backups are verified; remove its exact directory
manually only when you no longer need credentials, history and uploads. Existing
system installations need removal of their specifically configured units under
`/etc/systemd/system/`, followed by `sudo systemctl daemon-reload`. Do not run
system-unit removal commands against a user installation.
