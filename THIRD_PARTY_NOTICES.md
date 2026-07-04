# Third Party Notices

Vibration Community is distributed under `GPL-3.0-or-later`. This file lists
third-party components used by the Community edition and the license under
which each component is made available by its authors.

This notice is informational and is not legal advice. When redistributing a
binary or modified distribution, keep the corresponding upstream license texts
with the distribution where required.

## Vendored Browser Code

| Component | Version | Location | License | Copyright / Notice |
| --- | --- | --- | --- | --- |
| PDF.js | `4.10.38` | `web/vendor/pdfjs/` | Apache-2.0 | Copyright Mozilla and contributors. Full license text is stored in `web/vendor/pdfjs/LICENSE`. |

## Go Modules

| Module | Version | License | Notice |
| --- | --- | --- | --- |
| `filippo.io/edwards25519` | `v1.2.0` | BSD-3-Clause | Copyright The Go Authors. |
| `github.com/SherClockHolmes/webpush-go` | `v1.4.0` | MIT | Copyright Ethan Holmes. |
| `github.com/dustin/go-humanize` | `v1.0.1` | MIT | Copyright Dustin Sallings. |
| `github.com/go-sql-driver/mysql` | `v1.10.0` | MPL-2.0 | Copyright The Go-MySQL-Driver Authors. Present for shared error compatibility; MySQL deployment is not a Community feature. |
| `github.com/golang-jwt/jwt/v5` | `v5.2.1` | MIT | Copyright Dave Grijalva and golang-jwt maintainers. |
| `github.com/google/uuid` | `v1.6.0` | BSD-3-Clause | Copyright Google Inc. |
| `github.com/gorilla/websocket` | `v1.5.3` | BSD-2-Clause | Copyright The Gorilla WebSocket Authors. |
| `github.com/jackc/pgpassfile` | `v1.0.0` | MIT | Copyright Jack Christensen. |
| `github.com/jackc/pgservicefile` | `v0.0.0-20240606120523-5a60cdf6a761` | MIT | Copyright Jack Christensen. |
| `github.com/jackc/pgx/v5` | `v5.10.0` | MIT | Copyright Jack Christensen. Present for shared error compatibility; PostgreSQL deployment is not a Community feature. |
| `github.com/jackc/puddle/v2` | `v2.2.2` | MIT | Copyright Jack Christensen. |
| `github.com/mattn/go-isatty` | `v0.0.20` | MIT | Copyright Yasuhiro Matsumoto. |
| `github.com/ncruces/go-strftime` | `v0.1.9` | MIT | Copyright Nuno Cruces. |
| `github.com/remyoudompheng/bigfft` | `v0.0.0-20230129092748-24d4a6f8daec` | BSD-3-Clause | Copyright The Go Authors. |
| `golang.org/x/crypto` | `v0.31.0` | BSD-3-Clause | Copyright The Go Authors. |
| `golang.org/x/sync` | `v0.17.0` | BSD-3-Clause | Copyright The Go Authors. |
| `golang.org/x/sys` | `v0.28.0` | BSD-3-Clause | Copyright The Go Authors. |
| `golang.org/x/text` | `v0.29.0` | BSD-3-Clause | Copyright The Go Authors. |
| `modernc.org/libc` | `v1.55.3` | BSD-3-Clause | Copyright The Libc Authors. |
| `modernc.org/mathutil` | `v1.6.0` | BSD-3-Clause | Copyright The mathutil Authors. |
| `modernc.org/memory` | `v1.8.0` | BSD-3-Clause | Copyright The Memory Authors. |
| `modernc.org/sqlite` | `v1.34.5` | BSD-3-Clause | Copyright The Sqlite Authors. |

## npm Packages

The exported Community `package-lock.json` currently contains only the root
project package and no npm dependency tree. The Enterprise working tree can
contain Tauri-related npm packages, but those are not included in the Community
export.

## Full License Texts

- Vibration: `LICENSE`
- PDF.js: `web/vendor/pdfjs/LICENSE`
- Go modules: license files are part of the module source downloaded and
  verified through `go.sum`.

The dependency inventory can be reproduced with the commands listed in
[DEPENDENCIES.md](DEPENDENCIES.md).
