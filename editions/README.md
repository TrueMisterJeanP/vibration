# Editions Vibration

Le projet se maintient comme un codebase principal, avec une frontiere claire entre le socle commun et l'edition Enterprise.

## Principe

- Le code commun contient la messagerie, les contacts, les groupes, le chiffrement navigateur, les fichiers, les appels WebRTC, le tableau blanc, les notifications et le serveur Go.
- L'edition Community est publiee sous GPL-3.0-or-later sur GitHub.
- L'edition Enterprise reste distribuee aux clients payants sous GPL-3.0-or-later, avec les modules d'administration avances, la configuration serveur, Coturn, federation et accompagnement self-hosted.
- Les corrections communes doivent etre faites dans le socle commun avant tout export Community.
- Les corrections propres a l'administration ou au deploiement client restent dans l'edition Enterprise.

## Perimetre Community public

La version Community publiee sur GitHub doit rester claire :

- pas de console d'administration ;
- pas de panneau gestionnaire ;
- pas de code d'activation ;
- inscriptions ouvertes ;
- pas de federation ;
- base SQLite uniquement ;
- pas de configuration Coturn ;
- pas de wrapper desktop/mobile Tauri ;
- WebRTC limite a `stun:stun.l.google.com:19302`.

La page GitHub doit renvoyer vers l'offre Enterprise pour l'administration complete, Coturn prive, federation, base externe et support : https://vibration-shop.appbox.fr

## Compilation

Edition Enterprise locale, comportement par defaut :

```bash
go run ./cmd/server
go test ./...
```

Edition Community :

```bash
go run -tags community ./cmd/server
go test -tags community ./cmd/server ./internal/... 
```

L'endpoint `GET /api/edition` indique au client web quelle interface afficher.

## Publication Community

Generer une copie publique :

```bash
sh scripts/export-community.sh ../vibration-community
```

Le script utilise `editions/community.exclude` pour retirer les fichiers locaux, les captures de travail et les modules Enterprise.

Avant publication :

```bash
cd ../vibration-community
GOCACHE=/tmp/webtchat-go-cache go test -tags community ./...
npm run check:js
```

## Regle de maintenance

Ne pas maintenir deux copies a la main. Les changements partent du projet Enterprise local, puis la version Community est regeneree par export quand elle doit etre publiee.
