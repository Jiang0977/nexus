# Third-party software

Nexus is based on Nexus4CC by librae8226, faywong and contributors; see LICENSE.md.
The project also uses Rust crates and frontend packages under their respective
licenses. Exact dependency versions are recorded in `rust-runtime/Cargo.lock`
and `frontend/package-lock.json`.

- `rust-runtime/vendor/avt/`: modified avt terminal emulator, MIT; retain both
  `LICENSE` and `XTERM-LICENSE` when redistributing it.
- Frontend: React, xterm.js and addons, i18next, marked, DOMPurify and their
  transitive dependencies. Their license texts are collected in release packages.
- Rust runtime: dependencies listed in Cargo.toml and Cargo.lock. Release packages
  include dependency attribution and available license/notice files.

`npm run package:release` creates `THIRD_PARTY_NOTICES.txt` inside the binary
archive. The matching source archive includes the project source and vendored
Rust dependencies with an offline Cargo source configuration. Do not remove the
original dependency notices when creating downstream distributions.

`html-parse-stringify` 3.0.1 declares MIT but omits its license file from the npm
package. `docs/licenses/html-parse-stringify-LICENSE` preserves the text supplied
by its upstream repository (https://github.com/henrikjoreteg/html-parse-stringify/blob/master/LICENSE).
`alloc-stdlib` shares the Dropbox BSD-3-Clause notice shipped by its sibling
`alloc-no-stdlib`; the packager includes that notice for both.
