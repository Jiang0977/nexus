# Current roadmap

Updated: 2026-09-10. Runtime truth comes from current source and tests, followed by
AGENTS.md and ARCHITECTURE.md / code.md. This page summarizes scope; detailed
acceptance criteria live in [TODOS.md](../TODOS.md).

## Current capabilities

- Single-user browser/PWA workbench with a Rust runtime.
- tmux default backend; native PTY remains opt-in/staging.
- Project/channel management, desktop split panes, file browser, prompt library.
- Codex/Claude launch profiles and Codex history/resume.
- tmux redraw and native state-checkpoint recovery implemented and tested in the
  documented local environments. Physical phones, provider availability and every
  terminal extension are not covered by those historical acceptance records.
- Public distribution uses GPL-3.0-or-later with upstream attribution, bilingual
  tutorials and a Linux x86_64 release package. Release checks are documented in
  [RELEASING.md](RELEASING.md).

## Remaining work

- Consolidate remaining tmux command helpers (P2); see TODOS.md for the exact scope.
- Broader native platform validation requires separate work before claiming support.

## Boundaries

No multi-user hosting, shared accounts or sandbox guarantee. The server runs with
its OS account's permissions; see [SECURITY.md](../SECURITY.md). Native must remain
reversible to tmux unless a future design explicitly changes the production default.

Historical records under `docs/verification/` are dated evidence with anonymized
paths and project names. Their test counts and commit identifiers are historical,
not a replacement for checking the current release.
