# Dependencies

This document describes the external dependencies used by the public
Vibration Community edition. It is intended to make the project auditable:
what is embedded, what is downloaded at build time, and what stays outside
the Community scope.

## Community Scope

Vibration Community is a self-hosted web/PWA application:

- Go server;
- browser client served from `web/`;
- SQLite local database;
- WebSocket realtime transport;
- Web Push notifications;
- no Tauri desktop/mobile wrapper;
- no administration console;
- no external managed database feature in the public UI/configuration.

The Community export rewrites `package.json` and `package-lock.json` with
Community-specific files from `editions/community.package.json` and
`editions/community.package-lock.json`. The exported package has no npm
runtime dependency.

## Runtime Dependencies

### Server

Go modules are resolved from `go.mod` and verified with `go.sum`.

| Dependency | Version | Purpose | License |
| --- | --- | --- | --- |
| `github.com/SherClockHolmes/webpush-go` | `v1.4.0` | Web Push encryption and delivery | MIT |
| `github.com/gorilla/websocket` | `v1.5.3` | WebSocket server transport | BSD-2-Clause |
| `golang.org/x/crypto` | `v0.31.0` | Cryptographic primitives used by server dependencies | BSD-3-Clause |
| `modernc.org/sqlite` | `v1.34.5` | Pure Go SQLite driver | BSD-3-Clause |
| `github.com/google/uuid` | `v1.6.0` | UUID generation | BSD-3-Clause |
| `github.com/golang-jwt/jwt/v5` | `v5.2.1` | JWT handling used by Web Push dependency chain | MIT |
| `filippo.io/edwards25519` | `v1.2.0` | Ed25519 implementation used by crypto dependency chain | BSD-3-Clause |
| `github.com/dustin/go-humanize` | `v1.0.1` | SQLite dependency chain utility | MIT |
| `github.com/ncruces/go-strftime` | `v0.1.9` | SQLite dependency chain utility | MIT |
| `github.com/remyoudompheng/bigfft` | `v0.0.0-20230129092748-24d4a6f8daec` | SQLite dependency chain utility | BSD-3-Clause |
| `golang.org/x/sys` | `v0.28.0` | System calls used by Go dependencies | BSD-3-Clause |
| `golang.org/x/text` | `v0.29.0` | Text processing used by dependency chain | BSD-3-Clause |
| `modernc.org/libc` | `v1.55.3` | Pure Go libc layer for SQLite | BSD-3-Clause |
| `modernc.org/mathutil` | `v1.6.0` | SQLite dependency chain utility | BSD-3-Clause |
| `modernc.org/memory` | `v1.8.0` | Memory management layer for SQLite | BSD-3-Clause |

The current shared server code also imports database driver types used to
normalize duplicate constraint errors across editions:

| Dependency | Version | Purpose in current code | License |
| --- | --- | --- | --- |
| `github.com/go-sql-driver/mysql` | `v1.10.0` | Error type compatibility in shared auth code | MPL-2.0 |
| `github.com/jackc/pgx/v5` | `v5.10.0` | PostgreSQL error type compatibility in shared auth code | MIT |
| `github.com/jackc/pgpassfile` | `v1.0.0` | `pgx` dependency | MIT |
| `github.com/jackc/pgservicefile` | `v0.0.0-20240606120523-5a60cdf6a761` | `pgx` dependency | MIT |
| `github.com/mattn/go-isatty` | `v0.0.20` | `pgx` dependency | MIT |

Community still exposes SQLite-only configuration. MySQL and PostgreSQL are
Enterprise deployment features, not Community features.

### Browser Client

The browser client uses standard browser APIs where possible:

- Web Crypto API for client-side encryption;
- IndexedDB for local key/device state;
- Service Worker and Push API for notifications;
- WebRTC APIs for calls and screen sharing;
- Fetch, WebSocket and File APIs.

The only vendored browser library in Community is:

| Dependency | Version | Location | Purpose | License |
| --- | --- | --- | --- | --- |
| PDF.js | `4.10.38` | `web/vendor/pdfjs/` | PDF preview/rendering | Apache-2.0 |

## Development Dependencies

The Community export has no npm package dependency. `npm ci` installs an empty
package graph and is kept in CI so `npm run check:js` has a stable entry point.

The Enterprise working tree can include additional local tooling, notably Tauri
packages and the `src-tauri/` application wrapper. These are deliberately
excluded from the Community export by `editions/community.exclude`.

## External Network Services

Community is self-hosted by default. The following network interactions are
worth auditing:

- Web Push uses the push service selected by the user's browser/vendor after
  the instance submits an encrypted notification payload.
- Calls use the public STUN server `stun:stun.l.google.com:19302` in Community.
  This is only for NAT discovery; it is not a TURN relay.
- No analytics, telemetry or hosted Vibration control plane is required by
  Community.

## Reproducing The Inventory

From the Community export:

```bash
GOCACHE=/tmp/webtchat-go-cache go list -deps -tags community -f '{{with .Module}}{{.Path}} {{.Version}}{{end}}' ./... | sort -u
npm ci
npm run check:js
find web/vendor -maxdepth 3 -type f | sort
```

License notices are summarized in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
