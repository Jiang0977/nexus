# Public-release preparation verification

Date: 2026-09-10. Scope: Linux x86_64 packaging and the existing single-user runtime.

- Repository checks passed: Rust tests, Node tests (including browser regressions),
  frontend build and committed-bundle consistency. Rust formatting and clippy passed.
- Setup regression tests cover required binary build, configure-only without systemd,
  credential preservation/reset, and failure before credential creation when a binary
  is missing. Existing setup fixtures verify user unit generation and invocation.
- Service tests cover user/system selection, explicit scope and ambiguous-scope rejection.
- Binary archive smoke used a fresh directory and a private tmux socket with an empty
  tmux configuration. It verified generated credentials, file mode 0600, health/auth,
  project creation, terminal input, reconnect, desktop/mobile login and refresh.
- Playwright used an installed Chrome executable through NEXUS_BROWSER_EXECUTABLE.
  Screenshots contain only a synthetic demo project; tmux host status was disabled.
- A fresh Ubuntu 24.04 container installed only documented runtime dependencies and
  verified extraction, configure-only, foreground startup and login.
- The source archive rebuilt Rust with `--offline --locked` and an initially empty
  Cargo cache, using the bundled dependency sources. Its included frontend packages
  rebuilt the frontend successfully.
- Gitleaks 8.30.1 examined available Git history. Three initial findings were reviewed:
  two copies of the public legacy JWT default (rejected by current runtime), and a
  minified xterm class-export expression. Narrow documented allowlists cover these;
  no credential finding remained in that scan.
- Current-tree personal host paths/project examples were anonymized; real credentials
  and runtime data are excluded from packages. Git author/history publication is a
  separate privacy decision and must be checked before changing repository visibility.

Limits: this does not certify physical phones, other architectures/distributions,
AI-provider availability or every terminal extension. Systemd installation was
verified with isolated command fixtures, not a full systemd boot inside the container.
No personal production service was restarted by this release preparation.
