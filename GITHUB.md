# Publier la version Community sur GitHub

Ce guide explique comment publier la version Community de Vibration depuis le dossier local Enterprise `WebTchat`.

La version Community est generee par export. Ne publiez pas directement le dossier Enterprise complet si vous voulez conserver les modules d'administration avances hors du depot public.

La version GitHub doit etre presentee comme **Vibration Community** :

- pas d'interface administration ;
- pas de federation ;
- SQLite uniquement ;
- pas de code d'activation ;
- inscriptions ouvertes ;
- pas de configuration Coturn ;
- pas de wrapper desktop/mobile Tauri ;
- appels avec `stun:stun.l.google.com:19302` uniquement.

Le README public doit aussi mentionner l'edition Enterprise et son URL : https://vibration-shop.appbox.fr

## 1. Verifier les fichiers a ne pas publier

Le projet contient des fichiers locaux qui ne doivent pas etre envoyes sur GitHub :

- `data/chat.db`, `data/chat.db-wal`, `data/chat.db-shm` : base de donnees locale.
- `data/app_secret` : secret applicatif.
- `data/vapid.json` : clefs de notifications push.
- `node_modules/` : dependances installees localement.
- `dist/` : exports locaux regenerables.
- `src-tauri/` : application desktop/mobile Tauri, hors perimetre Community.
- `server`, `vibration-server` : binaires locaux ou binaires Linux de deploiement.
- `.env`, `*.pem`, `*.key`, `certs/`, `turnserver.conf` : configuration locale, certificats et secrets Coturn.
- `.DS_Store` : fichier macOS inutile.

Le fichier `.gitignore` du projet ignore deja ces elements importants.

Le projet est publie sous licence GPL-3.0-or-later. Le fichier `LICENSE` doit etre present avant le premier commit.

## 2. Creer un depot vide sur GitHub

1. Connecte-toi a GitHub.
2. Clique sur **New repository**.
3. Choisis un nom, par exemple `WebTchat`.
4. Choisis **Public** ou **Private**.
5. Ne coche pas `Add a README file`, car le projet contient deja un `README.md`.
6. Clique sur **Create repository**.

GitHub affichera ensuite une URL du type :

```bash
https://github.com/TON_COMPTE/WebTchat.git
```

ou, en SSH :

```bash
git@github.com:TON_COMPTE/WebTchat.git
```

## 3. Initialiser Git dans le projet

Depuis le terminal, genere d'abord la copie Community :

```bash
cd /Users/jean-pierre/Codex/WebTchat
sh scripts/export-community.sh ../vibration-community
cd ../vibration-community
```

Puis initialise Git dans cette copie :

```bash
pwd
```

Initialise le depot Git :

```bash
git init
```

## 4. Verifier ce qui sera envoye

Affiche les fichiers que Git voit :

```bash
git status
```

Tu ne dois pas voir `data/chat.db`, `data/app_secret`, `data/vapid.json`, `node_modules/`, `dist/`, `src-tauri/`, `.env`, `turnserver.conf`, `certs/`, `*.pem` ou `*.key` dans les fichiers a ajouter.

Pour controler plus clairement :

```bash
git status --short
git add --dry-run .
git check-ignore -v data/chat.db data/app_secret data/vapid.json server vibration-server .env
```

`git add --dry-run .` ne doit pas afficher `data/chat.db`, `data/app_secret`, `data/vapid.json`, `server`, `vibration-server`, `.env`, `node_modules/`, `dist/` ou `src-tauri/`.

## 5. Verifier le projet avant publication

Depuis la racine de la copie Community :

```bash
GOCACHE=/tmp/webtchat-go-cache go test -count=1 -tags community ./...
GOCACHE=/tmp/webtchat-go-cache go vet -tags community ./...
GOCACHE=/tmp/webtchat-go-cache GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -tags community -o /tmp/vibration-server-github-check ./cmd/server
npm run check:js
```

GitHub executera aussi `.github/workflows/ci.yml` apres le push.

## 6. Creer le premier commit

Ajoute les fichiers du projet :

```bash
git add .
```

Verifie une derniere fois :

```bash
git status --short
```

Puis cree le commit :

```bash
git commit -m "Initial commit"
```

## 7. Lier le depot local a GitHub

Remplace `TON_COMPTE` par ton nom d'utilisateur GitHub.

Avec HTTPS :

```bash
git remote add origin https://github.com/TON_COMPTE/WebTchat.git
```

Ou avec SSH :

```bash
git remote add origin git@github.com:TON_COMPTE/WebTchat.git
```

Verifie que le remote est bien configure :

```bash
git remote -v
```

## 8. Envoyer le projet sur GitHub

Renomme la branche principale en `main` :

```bash
git branch -M main
```

Envoie le projet :

```bash
git push -u origin main
```

Si GitHub demande une authentification avec HTTPS, utilise un **Personal Access Token** GitHub a la place du mot de passe.

## 9. Mettre a jour GitHub apres des modifications

Apres avoir modifie le projet :

```bash
git status
git add .
git commit -m "Description des modifications"
git push
```

## 10. En cas d'erreur courante

Si `git remote add origin` dit que `origin` existe deja :

```bash
git remote set-url origin https://github.com/TON_COMPTE/WebTchat.git
```

Si `git push` est refuse parce que le depot GitHub contient deja des fichiers :

```bash
git pull --rebase origin main
git push
```

Avant de publier, relis toujours `git status --short` pour eviter d'envoyer un secret ou une base de donnees locale.
