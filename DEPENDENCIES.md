# Dépendances

Ce document décrit les dépendances externes utilisées par l’édition publique
Vibration Community. Son objectif est de rendre le projet auditable : ce qui
est embarqué, ce qui est résolu à la compilation, et ce qui reste hors du
périmètre Community.

## Périmètre Community

Vibration Community est une application web/PWA auto-hébergeable :

- serveur Go ;
- client navigateur servi depuis `web/` ;
- base locale SQLite ;
- transport temps réel WebSocket ;
- notifications Web Push ;
- pas de wrapper desktop/mobile Tauri ;
- pas de console d’administration ;
- pas de fonctionnalité de base externe configurable dans l’interface ou la
  configuration publique.

L’export Community remplace `package.json` et `package-lock.json` par les
fichiers dédiés `editions/community.package.json` et
`editions/community.package-lock.json`. Les paquets npm déclarés sont
`hash-wasm`, utilisé pour reproduire et tester le module Argon2id, et `jsqr`,
utilisé pour lire localement les QR codes d’approbation. Les deux sont embarqués
dans `web/vendor/` ; le navigateur ne contacte aucun CDN.

## Dépendances d’exécution

### Serveur

Les modules Go sont déclarés dans `go.mod` et vérifiés par `go.sum`.

| Dépendance | Version | Rôle | Licence |
| --- | --- | --- | --- |
| `github.com/SherClockHolmes/webpush-go` | `v1.4.0` | chiffrement et envoi Web Push | MIT |
| `github.com/gorilla/websocket` | `v1.5.3` | transport WebSocket côté serveur | BSD-2-Clause |
| `github.com/skip2/go-qrcode` | `v0.0.0-20200617195104-da1b6568686e` | génération locale autonome des QR codes d’approbation de nouvel appareil | MIT |
| `golang.org/x/crypto` | `v0.52.0` | primitives cryptographiques utilisées par les dépendances serveur | BSD-3-Clause |
| `modernc.org/sqlite` | `v1.34.5` | pilote SQLite pur Go | BSD-3-Clause |
| `github.com/google/uuid` | `v1.6.0` | génération d’UUID | BSD-3-Clause |
| `github.com/golang-jwt/jwt/v5` | `v5.2.2` | gestion JWT utilisée par la chaîne Web Push | MIT |
| `filippo.io/edwards25519` | `v1.2.0` | implémentation Ed25519 utilisée par la chaîne crypto | BSD-3-Clause |
| `github.com/dustin/go-humanize` | `v1.0.1` | utilitaire de la chaîne SQLite | MIT |
| `github.com/ncruces/go-strftime` | `v0.1.9` | utilitaire de la chaîne SQLite | MIT |
| `github.com/remyoudompheng/bigfft` | `v0.0.0-20230129092748-24d4a6f8daec` | utilitaire de la chaîne SQLite | BSD-3-Clause |
| `golang.org/x/sys` | `v0.45.0` | appels système utilisés par les dépendances Go | BSD-3-Clause |
| `golang.org/x/text` | `v0.37.0` | traitement de texte utilisé par la chaîne de dépendances | BSD-3-Clause |
| `modernc.org/libc` | `v1.55.3` | couche libc pur Go pour SQLite | BSD-3-Clause |
| `modernc.org/mathutil` | `v1.6.0` | utilitaire de la chaîne SQLite | BSD-3-Clause |
| `modernc.org/memory` | `v1.8.0` | couche de gestion mémoire pour SQLite | BSD-3-Clause |

Le code serveur partagé importe aussi des types de pilotes de bases externes
afin de normaliser certaines erreurs d’unicité entre éditions :

| Dépendance | Version | Rôle dans le code actuel | Licence |
| --- | --- | --- | --- |
| `github.com/go-sql-driver/mysql` | `v1.10.0` | compatibilité des types d’erreurs dans le code d’authentification partagé | MPL-2.0 |
| `github.com/jackc/pgx/v5` | `v5.10.0` | compatibilité des types d’erreurs PostgreSQL dans le code d’authentification partagé | MIT |
| `github.com/jackc/pgpassfile` | `v1.0.0` | dépendance de `pgx` | MIT |
| `github.com/jackc/pgservicefile` | `v0.0.0-20240606120523-5a60cdf6a761` | dépendance de `pgx` | MIT |
| `github.com/mattn/go-isatty` | `v0.0.20` | dépendance de `pgx` | MIT |

Community expose uniquement une configuration SQLite. MySQL et PostgreSQL sont
des fonctions de déploiement Enterprise, pas des fonctions Community.

### Client navigateur

Le client navigateur s’appuie autant que possible sur les API standard :

- Web Crypto API pour le chiffrement côté navigateur ;
- IndexedDB pour l’état local des clefs et de l’appareil ;
- Service Worker et Push API pour les notifications ;
- API WebRTC pour les appels et le partage d’écran ;
- Fetch, WebSocket et File APIs.

Les bibliothèques navigateur embarquées dans Community sont :

| Dépendance | Version | Emplacement | Rôle | Licence |
| --- | --- | --- | --- | --- |
| PDF.js | `4.10.38` | `web/vendor/pdfjs/` | prévisualisation et rendu PDF | Apache-2.0 |
| PDF.js, moteur iOS 17 | `3.11.174` | `web/vendor/pdfjs-ios17/` | rendu PDF classique sans module ES ni Web Worker sur iOS/iPadOS 17 | Apache-2.0 |
| JSZip | `3.10.1` | `web/vendor/jszip/` | lecture locale des conteneurs Open XML | MIT |
| docx-preview | `0.4.0` | `web/vendor/docx-preview/` | prévisualisation des documents Word `.docx` | Apache-2.0 |
| ExcelJS | `4.4.0` | `web/vendor/exceljs/` | lecture et prévisualisation des classeurs Excel `.xlsx` | MIT |
| pptx-preview | `1.0.7` | `web/vendor/pptx-preview/` | prévisualisation des présentations PowerPoint `.pptx` | ISC |
| html2canvas | `1.4.1` | `web/vendor/html2canvas/` | capture fidèle des premières pages Office dans Firefox et Safari | MIT |
| hash-wasm | `4.12.0` | `web/vendor/hash-wasm/` | dérivation Argon2id des enveloppes d’identité v2 | MIT |
| jsQR | `1.4.0` | `web/vendor/jsqr/` | lecture locale des QR codes d’approbation d’un nouvel appareil | Apache-2.0 |

## Dépendances de développement

L’export Community fixe `hash-wasm` à la version `4.12.0` et `jsqr` à la version
`1.4.0`. `npm ci` permet de contrôler leur provenance et d’exécuter les tests
Node ; le code servi au navigateur demeure la copie locale versionnée sous
`web/vendor/`.

L’arborescence de travail Enterprise peut contenir des outils locaux
supplémentaires, notamment les paquets Tauri et le wrapper `src-tauri/`. Ces
éléments sont volontairement exclus de l’export Community par
`editions/community.exclude`.

## Services réseau externes

Community est auto-hébergeable par défaut. Les interactions réseau suivantes
méritent d’être auditées :

- Web Push utilise le service push choisi par le navigateur ou le système de
  l’utilisateur après l’envoi par l’instance d’une notification chiffrée.
- Les appels utilisent le serveur STUN public `stun:stun.l.google.com:19302`
  en Community. Il sert à la découverte NAT ; ce n’est pas un relais TURN.
- Community ne nécessite ni analytique, ni télémétrie, ni plan de contrôle
  hébergé par Vibration.

## Reproduire l’inventaire

Depuis l’export Community :

```bash
GOCACHE=/tmp/webtchat-go-cache go list -deps -tags community -f '{{with .Module}}{{.Path}} {{.Version}}{{end}}' ./... | sort -u
npm ci
npm run check:js
find web/vendor -maxdepth 3 -type f | sort
```

Les notices de licences sont résumées dans
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
