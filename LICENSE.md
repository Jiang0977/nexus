# License and attribution

This modified version of Nexus is distributed under the GNU General Public
License, version 3 or (at your option) any later version (`GPL-3.0-or-later`).
The complete license is in [COPYING](COPYING).

Copyright (C) 2026 librae8226, faywong — original Nexus / Nexus4CC contributors.
Modifications maintained by Jiang0977 and contributors.

Nexus is derived from [Nexus4CC](https://github.com/librae8226/nexus4cc).
The upstream GPL licensing commit is
[3800d62](https://github.com/librae8226/nexus4cc/commit/3800d62f045497b72a8ed4547053d03128167f1b).
This repository's modifications include the Rust runtime, native PTY backend,
terminal recovery, split view, and installation and documentation changes.
Modification dates and details are recorded in Git history and [CHANGELOG.md](CHANGELOG.md).

This program is free software: you can redistribute it and/or modify it under
the terms of the GNU General Public License as published by the Free Software
Foundation, either version 3 of the License, or (at your option) any later version.

This program is distributed in the hope that it will be useful, but WITHOUT ANY
WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
PARTICULAR PURPOSE. See the GNU General Public License for more details.

You should have received a copy of the GNU General Public License along with
this program. If not, see <https://www.gnu.org/licenses/>.

## Upstream commercial licensing

Upstream separately advertises commercial licensing from librae8226 and faywong.
That offer is not an offer by this fork and does not automatically cover this
fork's modifications. This fork does not grant an alternative proprietary license.
GPL-compliant commercial use and distribution are permitted by the GPL.

## Third-party components

Third-party components retain their own copyrights and licenses. In particular,
the modified `avt` terminal state engine retains its MIT license and XTerm notice
under `rust-runtime/vendor/avt/`. See [THIRD_PARTY.md](THIRD_PARTY.md).
