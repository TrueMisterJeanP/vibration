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
| PDF.js | `3.11.174` | `web/vendor/pdfjs-ios17/` | Apache-2.0 | Copyright Mozilla et contributeurs. Build de compatibilité réservé à iOS/iPadOS 17 ; le texte complet de la licence est conservé dans `web/vendor/pdfjs-ios17/LICENSE`. |
| JSZip | `3.10.1` | `web/vendor/jszip/` | MIT | Copyright Stuart Knightley, David Duponchel, Franz Buchinger, António Afonso. Le texte complet de la licence est conservé dans `web/vendor/jszip/LICENSE.markdown`. |
| docx-preview | `0.4.0` | `web/vendor/docx-preview/` | Apache-2.0 | Copyright Volodymyr Baydalka et contributeurs. Le texte complet de la licence est conservé dans `web/vendor/docx-preview/LICENSE`. |
| ExcelJS | `4.4.0` | `web/vendor/exceljs/` | MIT | Copyright Guyon Roche. Le texte complet de la licence est conservé dans `web/vendor/exceljs/LICENSE`. |
| pptx-preview | `1.0.7` | `web/vendor/pptx-preview/` | ISC | Copyright _hit757_ et contributeurs. Le texte complet de la licence est conservé dans `web/vendor/pptx-preview/LICENSE`. |
| html2canvas | `1.4.1` | `web/vendor/html2canvas/` | MIT | Copyright Niklas von Hertzen et contributeurs. Le texte complet de la licence est conservé dans `web/vendor/html2canvas/LICENSE`. |
| hash-wasm | `4.12.0` | `web/vendor/hash-wasm/` | MIT | Copyright Dani Biro. Le texte complet de la licence est conservé dans `web/vendor/hash-wasm/LICENSE`. |
| jsQR | `1.4.0` | `web/vendor/jsqr/` | Apache-2.0 | Copyright Cozmo et contributeurs. Le texte complet de la licence est conservé dans `web/vendor/jsqr/LICENSE`. |

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
| `github.com/skip2/go-qrcode` | `v0.0.0-20200617195104-da1b6568686e` | MIT | Copyright Tom Harwood. Génération locale autonome des QR codes d’approbation de nouvel appareil. |
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

Le `package-lock.json` exporté pour Community fixe `hash-wasm` `4.12.0` et
`jsqr` `1.4.0`, utilisés pour reproduire et tester les composants embarqués.
L’arborescence de travail Enterprise peut contenir d’autres paquets npm liés à
Tauri, qui ne sont pas inclus dans l’export Community.

## Textes de licence complets

- Vibration : `LICENSE`
- PDF.js : `web/vendor/pdfjs/LICENSE`
- PDF.js pour iOS 17 : `web/vendor/pdfjs-ios17/LICENSE`
- JSZip : `web/vendor/jszip/LICENSE.markdown`
- docx-preview : `web/vendor/docx-preview/LICENSE`
- ExcelJS : `web/vendor/exceljs/LICENSE`
- pptx-preview : `web/vendor/pptx-preview/LICENSE`
- html2canvas : `web/vendor/html2canvas/LICENSE`
- hash-wasm : `web/vendor/hash-wasm/LICENSE`
- jsQR : `web/vendor/jsqr/LICENSE`
- Modules Go : les fichiers de licence font partie du code source des modules
  téléchargés et vérifiés par `go.sum`.

L’inventaire des dépendances peut être reproduit avec les commandes listées dans
[DEPENDENCIES.md](DEPENDENCIES.md).
