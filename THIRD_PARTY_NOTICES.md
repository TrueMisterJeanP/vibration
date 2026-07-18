# Notices des composants tiers

Vibration Community est distribué sous licence `GPL-3.0-or-later`. Ce fichier
liste les composants tiers utilisés par l’édition Community et la licence sous
laquelle chaque composant est fourni par ses auteurs.

Cette notice est informative et ne constitue pas un avis juridique. Lors de la
redistribution d’un binaire ou d’une distribution modifiée, conservez les textes
de licence amont lorsque les licences concernées l’exigent.

## Code navigateur embarqué

| Composant | Version | Emplacement | Licence | Notice |
| --- | --- | --- | --- | --- |
| PDF.js | `4.10.38` | `web/vendor/pdfjs/` | Apache-2.0 | Copyright Mozilla et contributeurs. Le texte complet de la licence est conservé dans `web/vendor/pdfjs/LICENSE`. |

## Modules Go

| Module | Version | Licence | Notice |
| --- | --- | --- | --- |
| `filippo.io/edwards25519` | `v1.2.0` | BSD-3-Clause | Copyright The Go Authors. |
| `github.com/SherClockHolmes/webpush-go` | `v1.4.0` | MIT | Copyright Ethan Holmes. |
| `github.com/dustin/go-humanize` | `v1.0.1` | MIT | Copyright Dustin Sallings. |
| `github.com/go-sql-driver/mysql` | `v1.10.0` | MPL-2.0 | Copyright The Go-MySQL-Driver Authors. Présent pour la compatibilité d’erreurs du code partagé ; le déploiement MySQL n’est pas une fonction Community. |
| `github.com/golang-jwt/jwt/v5` | `v5.2.2` | MIT | Copyright Dave Grijalva et les mainteneurs golang-jwt. |
| `github.com/google/uuid` | `v1.6.0` | BSD-3-Clause | Copyright Google Inc. |
| `github.com/gorilla/websocket` | `v1.5.3` | BSD-2-Clause | Copyright The Gorilla WebSocket Authors. |
| `github.com/jackc/pgpassfile` | `v1.0.0` | MIT | Copyright Jack Christensen. |
| `github.com/jackc/pgservicefile` | `v0.0.0-20240606120523-5a60cdf6a761` | MIT | Copyright Jack Christensen. |
| `github.com/jackc/pgx/v5` | `v5.10.0` | MIT | Copyright Jack Christensen. Présent pour la compatibilité d’erreurs du code partagé ; le déploiement PostgreSQL n’est pas une fonction Community. |
| `github.com/jackc/puddle/v2` | `v2.2.2` | MIT | Copyright Jack Christensen. |
| `github.com/mattn/go-isatty` | `v0.0.20` | MIT | Copyright Yasuhiro Matsumoto. |
| `github.com/ncruces/go-strftime` | `v0.1.9` | MIT | Copyright Nuno Cruces. |
| `github.com/remyoudompheng/bigfft` | `v0.0.0-20230129092748-24d4a6f8daec` | BSD-3-Clause | Copyright The Go Authors. |
| `golang.org/x/crypto` | `v0.52.0` | BSD-3-Clause | Copyright The Go Authors. |
| `golang.org/x/sync` | `v0.20.0` | BSD-3-Clause | Copyright The Go Authors. |
| `golang.org/x/sys` | `v0.45.0` | BSD-3-Clause | Copyright The Go Authors. |
| `golang.org/x/text` | `v0.37.0` | BSD-3-Clause | Copyright The Go Authors. |
| `modernc.org/libc` | `v1.55.3` | BSD-3-Clause | Copyright The Libc Authors. |
| `modernc.org/mathutil` | `v1.6.0` | BSD-3-Clause | Copyright The mathutil Authors. |
| `modernc.org/memory` | `v1.8.0` | BSD-3-Clause | Copyright The Memory Authors. |
| `modernc.org/sqlite` | `v1.34.5` | BSD-3-Clause | Copyright The Sqlite Authors. |

## Paquets npm

Le `package-lock.json` exporté pour Community ne contient actuellement que le
paquet racine du projet et aucun arbre de dépendances npm. L’arborescence de
travail Enterprise peut contenir des paquets npm liés à Tauri, mais ils ne sont
pas inclus dans l’export Community.

## Textes de licence complets

- Vibration : `LICENSE`
- PDF.js : `web/vendor/pdfjs/LICENSE`
- Modules Go : les fichiers de licence font partie du code source des modules
  téléchargés et vérifiés par `go.sum`.

L’inventaire des dépendances peut être reproduit avec les commandes listées dans
[DEPENDENCIES.md](DEPENDENCIES.md).
