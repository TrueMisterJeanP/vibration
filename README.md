# Vibration

Application de messagerie web installable, responsive et chiffrée côté navigateur. Le serveur Go assure l’authentification, le routage REST/WebSocket, la persistance SQLite et les notifications Web Push, sans jamais déchiffrer les messages, noms de groupes ou fichiers.

## Philosophie

Vibration est né d'une idée simple : permettre à chacun de reprendre la maîtrise de ses données et de ses communications.

La version publiée sur GitHub est l’édition **Community**. Elle permet d’installer une messagerie privée sur son propre serveur, avec un serveur Go léger, une interface web/PWA et une base SQLite locale. Le contenu des conversations reste chiffré côté navigateur : le serveur stocke et route les données, mais ne lit pas les messages ni les fichiers.

## Edition Community

La version Community est volontairement simple à installer et à comprendre.

Elle inclut :

- inscription libre des utilisateurs ;
- conversations privées ;
- groupes ;
- contacts ;
- messages chiffrés ;
- fichiers chiffrés ;
- appels audio/vidéo WebRTC ;
- tableau blanc partagé pendant les appels ;
- notifications Web Push ;
- interface web installable comme PWA ;
- stockage SQLite local.

Elle n’inclut pas :

- pas de console d’administration complète ;
- pas de panneau gestionnaire ;
- pas de code d’activation : tout le monde peut s’inscrire si l’instance est publique ;
- pas de fédération entre serveurs ;
- pas de migration MariaDB/MySQL/PostgreSQL ;
- pas de configuration Coturn ;
- pas de configuration WebRTC avancée ;
- pas d’application desktop/mobile Tauri ;
- appels WebRTC avec uniquement `stun:stun.l.google.com:19302`.

## Audit et sécurité

La version Community est pensée pour être inspectable. Les documents suivants
décrivent le périmètre public, les dépendances et les règles de sécurité :

- [DEPENDENCIES.md](DEPENDENCIES.md) : inventaire des dépendances et services externes ;
- [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) : licences des composants tiers ;
- [SECURITY.md](SECURITY.md) : politique de signalement et modèle de sécurité ;
- [COMMUNITY_VS_ENTERPRISE.md](COMMUNITY_VS_ENTERPRISE.md) : différences entre Community et Enterprise.

## Edition Enterprise

L’édition Enterprise est destinée aux organisations qui veulent reprendre la main sur leurs communications en production.

Elle ajoute notamment :

- administration complète des membres ;
- rôles administrateur et gestionnaire ;
- bannissement, révocation des sessions et journal d’audit ;
- modération par métadonnées sans accès au contenu clair ;
- code d’activation pour contrôler les inscriptions ;
- configuration Coturn privée pour fiabiliser les appels ;
- fédération entre instances approuvées ;
- configuration WebRTC depuis l’administration ;
- migration ou recopie vers MariaDB/MySQL ou PostgreSQL ;
- accompagnement d’installation, sauvegarde, maintenance et support.

Offre Enterprise : https://vibration-shop.appbox.fr

## Installation rapide Community

Prérequis :

- Go 1.25 ou supérieur ;
- un navigateur récent ;
- `localhost` ou HTTPS pour la PWA et les notifications Push.

Depuis le dossier du projet Community :

```bash
go run -tags community ./cmd/server
```

Ouvrir ensuite :

```text
http://localhost:8080
```

Au premier lancement, l’application crée automatiquement :

- `data/chat.db` ;
- `data/app_secret` ;
- `data/vapid.json`.

## Installation serveur Community

Compiler le serveur :

```bash
GOCACHE=/tmp/webtchat-go-cache GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -tags community -o vibration-server ./cmd/server
```

Envoyer sur le serveur :

```text
vibration-server
web/
```

Exemple d’arborescence :

```text
/opt/vibration/
├── vibration-server
├── web/
└── data/
```

Créer le service systemd :

```ini
[Unit]
Description=Vibration Community
After=network.target

[Service]
Type=simple
User=vibration
WorkingDirectory=/opt/vibration
Environment=ADDR=:8080
Environment=DATA_DIR=/opt/vibration/data
Environment=WEB_DIR=/opt/vibration/web
Environment=SECURE_COOKIES=true
ExecStart=/opt/vibration/vibration-server
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

Activer le service :

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now vibration
sudo systemctl status vibration
```

Placer ensuite Vibration derrière un reverse proxy HTTPS, par exemple Nginx ou Caddy. HTTPS est recommandé pour les cookies sécurisés, la PWA et les notifications.

## Fonctionnalités communes

- client web configurable : l’URL de l’instance serveur est demandée à l’inscription, réclamée à la connexion seulement si l’instance enregistrée est inaccessible, et peut être modifiée dans **Mon profil** ;
- inscription, connexion et sessions par cookie `HttpOnly` avec `SameSite` configurable ;
- réinitialisation du mot de passe via code de récupération personnel ;
- mots de passe hachés avec bcrypt (coût 12) ;
- identité ECDH P-256 générée avec WebCrypto dans le navigateur ;
- clé privée chiffrée par AES-GCM avec une clé PBKDF2 dérivée de la phrase secrète ;
- contacts et recherche par nom d’utilisateur ;
- conversations privées avec clé AES dérivée par ECDH + HKDF ;
- groupes avec clé AES aléatoire enveloppée par ECDH pour chaque membre ;
- messages texte AES-GCM, IV unique, historique paginé à 50 messages ;
- réponses, réactions, messages épinglés et messages éphémères configurables par appui long sur **Envoyer** ;
- messages vocaux enregistrés dans le navigateur puis envoyés comme fichiers audio chiffrés ;
- fichiers, nom de fichier et type MIME chiffrés avant envoi, limite 10 Mo ;
- événements WebSocket : nouveaux messages, reçu, lu, saisie, présence et mise à jour ;
- PWA, cache applicatif hors ligne, icônes 192/512 et Service Worker ;
- abonnements Web Push persistés dans SQLite et clés VAPID générées automatiquement ;
- interface mobile et bureau en HTML, CSS et JavaScript natif.

## Fonctionnalités Enterprise

- premier compte automatiquement administrateur, y compris lors de la migration d’une ancienne base ;
- administration des membres : promotion, rétrogradation, bannissement, débannissement et révocation des sessions ;
- modération des messages chiffrés par métadonnées et journal d’audit des actions ;
- code d’activation configurable ;
- configuration Coturn/WebRTC ;
- fédération privée ;
- migration ou recopie vers MariaDB/MySQL ou PostgreSQL.

## Récupération de compte

Chaque nouveau compte reçoit un code de récupération affiché une seule fois après l’inscription. Ce code permet de définir un nouveau mot de passe depuis l’écran de connexion. Un utilisateur connecté peut générer un nouveau code depuis **Mon profil > Récupération du compte** ; l’ancien code devient alors invalide.

Cette récupération ne remplace pas la phrase secrète de chiffrement. Si cette phrase est perdue, le serveur ne peut pas déchiffrer les anciens messages.

## Test avec deux utilisateurs

1. Ouvrir `http://localhost:8080/login.html` dans un navigateur normal.
2. Créer `alice_test` avec un mot de passe et une phrase secrète de chiffrement.
3. Ouvrir une fenêtre privée ou un second profil de navigateur.
4. Créer `bob_test` avec sa propre phrase secrète.
5. Chez Alice, cliquer sur **+ Contact**, rechercher `bob_test`, puis l’ajouter.
6. La conversation privée s’ouvre. Envoyer un message.
7. Vérifier chez Bob que le message arrive sans rechargement.
8. Répondre chez Bob et vérifier les indicateurs envoyé/reçu/lu chez Alice.
9. Utiliser le bouton trombone pour envoyer un fichier de moins de 10 Mo.
10. Chez Bob, cliquer sur la carte fichier : le navigateur télécharge le contenu chiffré, le déchiffre localement, puis propose le fichier clair.
11. Ajouter au besoin un troisième compte comme contact, cliquer sur **+ Groupe**, choisir les membres et envoyer un message de groupe.

Chaque utilisateur doit conserver sa phrase secrète. Le serveur ne peut ni la récupérer ni réinitialiser la clé privée si elle est perdue.

## Notifications Push

1. À la connexion ou à l’inscription, accepter la permission demandée par le navigateur.
2. L’abonnement Push est ensuite créé automatiquement à l’ouverture de l’application.
3. Cliquer sur **Tester** pour contrôler la livraison.
4. Si la permission a été refusée ou ignorée, utiliser **Activer les notifications** après l’avoir autorisée dans les réglages du site.
5. Pour tester un nouveau message, fermer ou placer l’onglet destinataire en arrière-plan, puis envoyer un message depuis l’autre compte.

Le serveur envoie uniquement :

- titre : `Nouveau message` ;
- corps : `Ouvrez l’application pour le lire.`

Le contenu clair n’est jamais inclus dans la notification. Selon le navigateur et le système, les notifications locales peuvent être limitées même sur `localhost`. Pour un déploiement distant, HTTPS est obligatoire.

Navigateurs pris en charge : versions récentes de Chrome, Edge, Firefox et Safari. Sur iPhone et iPad, le Web Push fonctionne uniquement lorsque l’application a été ajoutée à l’écran d’accueil et ouverte depuis son icône. Les navigateurs sans API Push ne peuvent pas recevoir de Web Push.

En PWA, la réception des notifications dépend du support Web Push du navigateur et du système. Sur mobile, certaines restrictions peuvent s’appliquer quand l’application est fermée.

## Profil utilisateur

Cliquer sur le nom du compte dans l’en-tête de la barre latérale pour ouvrir **Mon profil**. Chaque utilisateur peut modifier son nom d’utilisateur, son nom affiché et son mot de passe. Le mot de passe actuel est requis pour changer l’identifiant de connexion ou le mot de passe. La réactivation et le test des notifications sont également disponibles dans ce menu.

Chaque utilisateur peut aussi choisir ou supprimer un avatar depuis son profil. L’image est recadrée et redimensionnée à 256 × 256 dans le navigateur avant son enregistrement. Elle remplace le logo dans l’en-tête personnel et apparaît dans les conversations privées et les messages.

À l’inscription, la clé de chiffrement est mémorisée automatiquement sur l’appareil. La phrase n’est pas stockée : la clé privée déverrouillée est chiffrée par une clé AES non exportable conservée dans IndexedDB. La connexion demande ensuite uniquement l’identifiant et le mot de passe. La phrase secrète est exigée à la première connexion, puis de manière aléatoire entre 20 et 40 connexions, ou plus tôt si les données locales ont été effacées. La clé mémorisée peut être supprimée depuis le profil.

## Chiffrement

### Identité

L’inscription crée une paire ECDH P-256 avec WebCrypto. La clé publique est envoyée au serveur. La clé privée est exportée au format JWK, chiffrée en AES-256-GCM avec une clé dérivée de la phrase secrète par PBKDF2-SHA-256 (310 000 itérations), puis seule l’enveloppe chiffrée est envoyée.

Le mot de passe de connexion et la phrase secrète ont des rôles distincts :

- le mot de passe est envoyé par HTTPS/localhost au serveur pour l’authentification et stocké sous forme bcrypt ;
- la phrase secrète ne quitte jamais le navigateur.

### Conversations privées

Les deux navigateurs calculent le même secret ECDH à partir de leurs clés. HKDF-SHA-256, salé par l’identifiant de conversation, produit une clé AES-256-GCM. Le serveur stocke `ecdh-v1` dans la colonne d’enveloppe technique et ne possède pas la clé.

### Groupes

Le créateur génère une clé AES-256-GCM aléatoire. Cette clé est chiffrée séparément pour chaque membre avec une clé d’enveloppement ECDH + HKDF. SQLite ne contient que les enveloppes chiffrées. Le titre du groupe utilise la clé du groupe.

### Messages et fichiers

Chaque texte et chaque fichier utilise un IV AES-GCM aléatoire de 96 bits. Le nom et le type MIME des fichiers sont des enveloppes AES-GCM distinctes. Les fichiers ne sont téléchargés et déchiffrés qu’après un clic.

## WebSocket

Le navigateur se connecte à `GET /api/ws` avec le cookie de session. Le serveur associe la connexion à l’utilisateur et route uniquement des métadonnées et charges chiffrées. Une reconnexion exponentielle automatique est intégrée au frontend.

## API principale

Routes disponibles dans l'édition Community.

Auth :

- `GET /api/registration`
- `POST /api/register`
- `POST /api/login`
- `POST /api/password/reset`
- `POST /api/logout`
- `GET /api/me`
- `PUT /api/me`
- `POST /api/me/recovery-code`

Contacts et utilisateurs :

- `GET /api/users/search?q=`
- `GET /api/contacts`
- `POST /api/contacts`
- `POST /api/contacts/{id}/accept`
- `DELETE /api/contacts/{id}`

Conversations :

- `GET /api/conversations`
- `POST /api/conversations/private`
- `POST /api/conversations/group`
- `GET /api/conversations/{id}`
- `POST /api/conversations/{id}/accept`
- `PUT /api/conversations/{id}`
- `DELETE /api/conversations/{id}`
- `GET /api/conversations/{id}/members`
- `POST /api/conversations/{id}/members`
- `DELETE /api/conversations/{id}/members/{user_id}`

Messages et fichiers :

- `GET /api/conversations/{id}/messages?limit=50&before=`
- `POST /api/conversations/{id}/messages`
- `POST /api/messages/{id}/read`
- `POST /api/messages/{id}/reactions`
- `POST /api/messages/{id}/pin`
- `PUT /api/messages/{id}`
- `DELETE /api/messages/{id}`
- `POST /api/files`
- `GET /api/files/{id}`

Push :

- `GET /api/push/vapid-public-key`
- `GET /api/push/status`
- `POST /api/push/subscribe`
- `POST /api/push/unsubscribe`
- `POST /api/push/test`

Appels :

- `GET /api/calls/config`
- `GET /api/ws`

## Configuration

En Community, la configuration reste volontairement réduite : SQLite uniquement, inscriptions ouvertes, pas de code d'activation, pas de fédération et pas de Coturn configurable. Les variables de base externe, de fédération, de redémarrage administré et de TURN privé sont réservées à l'édition Enterprise.

Variables d’environnement :

| Variable | Défaut | Rôle |
|---|---|---|
| `ADDR` | `:8080` | adresse d’écoute |
| `DATA_DIR` | `data` | répertoire des données |
| `WEB_DIR` | `web` | répertoire des fichiers statiques servis par le backend |
| `DATABASE_PATH` | `data/chat.db` | chemin SQLite |
| `APP_SECRET` | fichier généré | secret local réservé aux extensions de session |
| `SECURE_COOKIES` | `false` | activer l’attribut cookie `Secure` en HTTPS |
| `SESSION_SAME_SITE` | `lax` | mode SameSite du cookie de session : `lax`, `strict` ou `none` |
| `VAPID_SUBJECT` | `admin@example.com` | adresse de contact VAPID, sans préfixe `mailto:` |
| `AUTH_RATE_LIMIT_PER_MINUTE` | `20` | nombre maximal de tentatives de connexion ou inscription par minute, par IP et nom d’utilisateur |
| `CLIENT_ORIGINS` | vide | origines web autorisées à appeler l’API et le WebSocket, séparées par des virgules |

Exemple production derrière un reverse proxy HTTPS :

```bash
APP_SECRET="une-valeur-longue-et-aleatoire" \
SECURE_COOKIES=true \
SESSION_SAME_SITE=none \
CLIENT_ORIGINS=https://client.example.com \
VAPID_SUBJECT=admin@example.com \
go run -tags community ./cmd/server
```

Le serveur doit être placé derrière un reverse proxy HTTPS ; `SECURE_COOKIES=true` active aussi l’en-tête HSTS. L'édition Community garde les inscriptions ouvertes par conception.

Si le frontend web est servi depuis une origine différente de l’instance serveur, ajouter cette origine dans `CLIENT_ORIGINS` et utiliser `SESSION_SAME_SITE=none` avec `SECURE_COOKIES=true`. Sans ces réglages, le navigateur refusera les cookies de session cross-site ou les requêtes CORS.

En Community, les appels audio/vidéo utilisent uniquement `stun:stun.l.google.com:19302`. Google fournit ici un STUN de secours, pas un TURN public. Pour des appels plus fiables en production, notamment derrière certains pare-feu ou réseaux mobiles, l'édition Enterprise permet de configurer un Coturn privé.

## Structure

```text
Vibration/
├── cmd/server/main.go
├── editions/
│   ├── README.md
│   └── community.exclude
├── internal/
│   ├── auth/
│   ├── config/
│   ├── contacts/
│   ├── conversations/
│   ├── db/
│   ├── files/
│   ├── httpx/
│   ├── messages/
│   ├── push/
│   ├── users/
│   └── ws/
├── web/
│   ├── css/style.css
│   ├── icons/
│   ├── js/
│   ├── index.html
│   ├── login.html
│   ├── manifest.json
│   └── sw.js
├── data/.gitkeep
├── scripts/export-community.sh
├── COMMUNITY_VS_ENTERPRISE.md
├── DEPENDENCIES.md
├── SECURITY.md
├── THIRD_PARTY_NOTICES.md
├── go.mod
├── go.sum
└── README.md
```

## Commandes utiles

```bash
gofmt -w cmd internal
GOCACHE=/tmp/webtchat-go-cache go test -count=1 -tags community ./...
GOCACHE=/tmp/webtchat-go-cache go vet -tags community ./...
GOCACHE=/tmp/webtchat-go-cache GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -tags community -o /tmp/vibration-server ./cmd/server
npm run check:js
npm test
go run -tags community ./cmd/server
```

Réinitialiser uniquement les données locales de développement :

```bash
rm -f data/chat.db data/chat.db-shm data/chat.db-wal data/app_secret data/vapid.json
```

## Sécurité appliquée

- vérification de l’en-tête `Origin` et refus de `Sec-Fetch-Site: cross-site` sur les mutations API ;
- validation des tailles et identifiants côté serveur ;
- cookie de session opaque et aléatoire : session courte de 12 heures, ou session persistante de 30 jours si **Rester connecté** est coché ;
- limitation des tentatives d’inscription et de connexion ;
- limites de lecture JSON et fichier ;
- en-têtes CSP, `nosniff`, politique de référent et permissions restrictives ;
- aucune journalisation du contenu des messages, des fichiers ou des clés privées ;
- contrôle d’appartenance avant lecture d’une conversation ou d’un fichier.

## Limites connues de la V1

- ce projet fournit un chiffrement E2EE fonctionnel, mais n’a pas fait l’objet d’un audit cryptographique indépendant ;
- pas de Double Ratchet, de forward secrecy par message, de vérification d’empreinte/QR code ou de gestion multi-appareil ;
- la compromission d’une clé privée permet de dériver les conversations privées historiques ;
- après retrait d’un membre d’un groupe, la clé du groupe n’est pas automatiquement tournée ; il faut recréer un groupe pour exclure cryptographiquement l’ancien membre ;
- l’API permet au propriétaire d’ajouter/retirer des membres, mais l’interface V1 sélectionne principalement les membres à la création ;
- les appels audio/vidéo sont WebRTC et chiffrés par le navigateur, mais ne disposent pas encore d’une couche E2EE applicative indépendante avec vérification d’identité ;
- les appels audio/vidéo ne sont pas encore fédérés entre serveurs ;
- les métadonnées techniques restent visibles du serveur : comptes, appartenances, heures, tailles et fréquence ;
- la modération administrative des messages est nécessairement « aveugle » : l’administrateur ne peut pas lire le contenu E2EE et doit agir à partir des métadonnées ou d’un signalement externe ;
- cache PWA limité à l’interface ; les messages ne sont pas mis en cache hors ligne ;
- pas de recherche plein texte.

## Vérification du stockage chiffré

Après avoir envoyé un message, si l’outil `sqlite3` est installé :

```bash
sqlite3 data/chat.db "SELECT id, encrypted_content, iv FROM messages ORDER BY id DESC LIMIT 3;"
```

Le texte clair ne doit pas apparaître. Pour les fichiers :

```bash
sqlite3 data/chat.db "SELECT id, encrypted_name, encrypted_mime, length(encrypted_data), iv FROM files;"
```

## Licence

Vibration est distribué sous licence GNU General Public License v3.0 ou ultérieure (`GPL-3.0-or-later`). Consultez le fichier [LICENSE](LICENSE) pour le texte complet.

Le code reste la propriété de ses auteurs. La licence GPL autorise l’utilisation, l’étude, la modification et la redistribution du logiciel dans les conditions de cette licence.
