# Security

Nexus provides shell access as the operating-system account running its services.
It is a single-user tool, not a sandbox or a multi-user hosting platform.
`WORKSPACE_ROOT` scopes workspace browsing; it does not confine terminal commands.
Codex is launched with `--dangerously-bypass-approvals-and-sandbox`, and Claude
with `--dangerously-skip-permissions`. Use an account whose permissions you accept
exposing to your agents and authenticated browser sessions.

The server binds to `127.0.0.1` by default. Use a private VPN or an authenticated
HTTPS reverse proxy for remote access. A publicly reachable tunnel by itself is
not an access policy. Do not expose the server directly to the public internet.
WebSocket authentication currently uses a URL query token: redact query strings
in proxy/access logs. Login tokens last 30 days; rotating `JWT_SECRET` and
restarting Nexus invalidates existing tokens.

## Credentials and backups

`./setup.sh` generates a unique password and JWT secret. Save the displayed
password; there is no shared default. `.env` is written with mode 0600.
Agent profiles, runtime HOME directories, session history, uploads and prompts
under `data/` can contain credentials or confidential work. Keep them private.
Never attach `.env`, provider profiles, terminal recordings or unredacted logs to
an issue. Backups must be protected just like the live data.

## Reporting a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/Jiang0977/nexus/security/advisories/new).
Do not report secrets or exploitable vulnerabilities in public issues. Include
an affected version, a minimal reproduction with synthetic data, and impact.
Ordinary bugs can be reported through Issues. Security fixes target the latest
release; old tags are historical snapshots and are not maintained releases.

For dependency changes, run the repository checks and review dependency advisories.
The native backend remains opt-in; its availability is not a security certification.
