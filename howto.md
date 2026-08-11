# Déployer Vibration avec Apache et systemd

Cette configuration sépare :

- le backend Go, lancé comme service système ;
- le frontend statique, servi directement par Apache ;
- les données persistantes, conservées hors du code source.

## Arborescence recommandée

```text
/opt/vibration/backend/       Backend Go compilé
/var/lib/vibration/           Base SQLite, secret et clés VAPID
/var/www/vibration/web/       Frontend statique
/etc/systemd/system/vibration.service
```

## 1. Compiler le backend

Sur le serveur Linux, depuis le dossier du projet :

```bash
go build -o vibration-server ./cmd/server
```

Créer les dossiers de destination :

```bash
sudo mkdir -p /opt/vibration/backend
sudo mkdir -p /var/lib/vibration
sudo mkdir -p /var/www/vibration/web
```

Installer le backend et le frontend :

```bash
sudo cp vibration-server /opt/vibration/backend/
sudo cp -R web/. /var/www/vibration/web/
```

## 2. Créer l’utilisateur système

```bash
sudo useradd \
  --system \
  --home /var/lib/vibration \
  --shell /usr/sbin/nologin \
  vibration
```

Appliquer les permissions :

```bash
sudo chown -R vibration:vibration /opt/vibration/backend
sudo chown -R vibration:vibration /var/lib/vibration
sudo chown -R www-data:www-data /var/www/vibration
```

Le backend ne doit pas être exécuté avec l’utilisateur `root`.

## 3. Créer le service systemd

Créer `/etc/systemd/system/vibration.service` :

```ini
[Unit]
Description=Backend Vibration
After=network.target

[Service]
Type=simple
User=vibration
Group=vibration
WorkingDirectory=/opt/vibration/backend

Environment=ADDR=127.0.0.1:8080
Environment=DATA_DIR=/var/lib/vibration
Environment=DATABASE_PATH=/var/lib/vibration/chat.db
Environment=DATABASE_BACKUP_DIR=/var/lib/vibration/backups
# Laisser les opérations destructrices désactivées jusqu’au test de restauration.
Environment=ALLOW_DATABASE_DESTRUCTIVE_ACTIONS=false
Environment=SECURE_COOKIES=true
Environment=VAPID_SUBJECT=admin@votre-domaine.fr
Environment=FEDERATION_OUTBOX_BATCH=20
Environment=FEDERATION_OUTBOX_INTERVAL_SECONDS=30
Environment=FEDERATION_OUTBOX_WORKERS=1
Environment=FEDERATION_OUTBOX_SENT_RETENTION_HOURS=24

ExecStart=/opt/vibration/backend/vibration-server
Restart=on-failure
RestartSec=5

# Chaque utilisateur connecté occupe au moins un descripteur pour sa WebSocket,
# auxquels s'ajoutent les requêtes REST simultanées et les connexions à la base.
# La limite par défaut de systemd (1024) est atteinte bien avant 1 000 clients.
LimitNOFILE=65536

NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/var/lib/vibration

[Install]
WantedBy=multi-user.target
```

Remplacer `admin@votre-domaine.fr` par une adresse de contact valide.

Vérifier que la limite est bien appliquée au processus une fois le service démarré :

```bash
systemctl show vibration -p LimitNOFILE
grep 'Max open files' /proc/$(systemctl show -p MainPID --value vibration)/limits
```

Activer et démarrer le service :

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now vibration
sudo systemctl status vibration
```

Consulter ses journaux :

```bash
sudo journalctl -u vibration -f
```

Tester le backend localement :

```bash
curl -i http://127.0.0.1:8080/api/me
```

Une réponse `401 Unauthorized` confirme que le backend répond correctement.

## 4. Configurer Apache

Activer les modules nécessaires :

```bash
sudo a2enmod proxy
sudo a2enmod proxy_http
sudo a2enmod proxy_wstunnel
sudo a2enmod ssl
sudo a2enmod headers
```

Créer un VirtualHost, par exemple dans :

```text
/etc/apache2/sites-available/vibration.conf
```

Configuration :

```apache
<VirtualHost *:80>
    ServerName chat.votre-domaine.fr
    Redirect permanent / https://chat.votre-domaine.fr/
</VirtualHost>

<VirtualHost *:443>
    ServerName chat.votre-domaine.fr
    DocumentRoot /var/www/vibration/web

    SSLEngine On
    SSLCertificateFile /chemin/vers/fullchain.pem
    SSLCertificateKeyFile /chemin/vers/privkey.pem

    ProxyPreserveHost On

    # Cette règle WebSocket doit précéder la règle générale /api/.
    ProxyPass        /api/ws ws://127.0.0.1:8080/api/ws
    ProxyPassReverse /api/ws ws://127.0.0.1:8080/api/ws

    ProxyPass        /api/ http://127.0.0.1:8080/api/
    ProxyPassReverse /api/ http://127.0.0.1:8080/api/

    # Debian/Apache active souvent un alias global /icons/.
    # Cet alias local garantit que les icônes PWA de Vibration sont servies.
    Alias /icons/ "/var/www/vibration/web/icons/"

    <Directory "/var/www/vibration/web/icons">
        Require all granted
        Options -Indexes
    </Directory>

    # Point de découverte fédérée. Ne pas le laisser tomber dans le statique.
    ProxyPass        /.well-known/webtchat http://127.0.0.1:8080/.well-known/webtchat
    ProxyPassReverse /.well-known/webtchat http://127.0.0.1:8080/.well-known/webtchat

    <Directory /var/www/vibration/web>
        Require all granted
        Options -Indexes
        AllowOverride None
        DirectoryIndex index.html
    </Directory>

    <Files "sw.js">
        Header set Cache-Control "no-cache, no-store, must-revalidate"
    </Files>

    Header always set X-Content-Type-Options "nosniff"
    Header always set Referrer-Policy "no-referrer"
</VirtualHost>
```

Remplacer :

- `chat.votre-domaine.fr` par le domaine réel ;
- les chemins du certificat par ceux de votre certificat TLS.

Activer le site :

```bash
sudo a2ensite vibration.conf
sudo apachectl configtest
sudo systemctl reload apache2
```

### 4 bis. Apache et 1 000 WebSocket simultanées

Une WebSocket occupe un worker Apache pendant toute la durée de la connexion.
Avec la configuration Debian par défaut (`mpm_prefork`, `MaxRequestWorkers 150`),
le 151ᵉ client bloque tout le site, y compris les requêtes REST. Deux réglages
sont donc nécessaires.

Utiliser `mpm_event`, qui traite chaque connexion sur un thread plutôt que sur un
processus :

```bash
sudo a2dismod mpm_prefork php8.2   # php-fpm remplace mod_php si nécessaire
sudo a2enmod mpm_event proxy_wstunnel http2
```

Dimensionner le pool dans `/etc/apache2/mods-available/mpm_event.conf` :

```apache
<IfModule mpm_event_module>
    StartServers             4
    MinSpareThreads         75
    MaxSpareThreads        250
    ThreadLimit            128
    ThreadsPerChild        128
    # 1 200 connexions simultanées : les 1 000 WebSocket plus une marge pour le
    # trafic REST et les rechargements.
    MaxRequestWorkers     1280
    MaxConnectionsPerChild   0
    AsyncRequestWorkerFactor 2
</IfModule>
```

`MaxRequestWorkers` doit rester un multiple de `ThreadsPerChild` (ici 10 × 128).
`MaxConnectionsPerChild 0` évite qu'un recyclage de processus ne coupe des
WebSocket établies.

Relever la limite de descripteurs d'Apache lui aussi, sinon il refuse les
connexions bien avant le backend :

```bash
sudo systemctl edit apache2
```

```ini
[Service]
LimitNOFILE=65536
```

Le proxy doit laisser vivre les connexions inactives plus longtemps que le ping
applicatif (25 s) et que le délai de lecture du serveur (60 s) :

```apache
    ProxyPass /api/ws ws://127.0.0.1:8080/api/ws connectiontimeout=10 timeout=300
```

Vérifier après rechargement :

```bash
sudo apachectl -V | grep -i 'Server MPM'      # doit afficher "event"
sudo apachectl -t -D DUMP_MODULES | grep -E 'mpm|wstunnel'
# Nombre de connexions réellement établies vers le backend :
ss -tan state established '( sport = :8080 )' | wc -l
```

Sur un noyau Linux, relever aussi la file d'attente d'acceptation et la plage de
ports éphémères, faute de quoi une reconnexion simultanée de 1 000 clients se
solde par des refus :

```bash
sudo sysctl -w net.core.somaxconn=4096
sudo sysctl -w net.ipv4.ip_local_port_range="10240 65535"
sudo sysctl -w net.ipv4.tcp_max_syn_backlog=4096
```

Rendre ces valeurs persistantes dans `/etc/sysctl.d/60-vibration.conf`.

## 5. Installer un certificat avec Certbot

Si aucun certificat n’est encore installé :

```bash
sudo apt install certbot python3-certbot-apache
sudo certbot --apache -d chat.votre-domaine.fr
```

Les notifications Web Push nécessitent HTTPS, sauf sur `localhost`.

## 6. Vérifications

Vérifier le frontend :

```text
https://chat.votre-domaine.fr/login.html
```

Vérifier l’API :

```bash
curl -i https://chat.votre-domaine.fr/api/registration
curl -i https://chat.votre-domaine.fr/api/me
```

`/api/registration` doit répondre `200 OK`. `/api/me` doit répondre `401 Unauthorized` lorsqu’aucune session n’est fournie.

Vérifier les icônes et la découverte fédérée :

```bash
curl -I https://chat.votre-domaine.fr/icons/group.svg
curl -I https://chat.votre-domaine.fr/icons/person.svg
curl -i https://chat.votre-domaine.fr/.well-known/webtchat
```

Les icônes doivent répondre `200 OK`. `/.well-known/webtchat` doit répondre en JSON si `FEDERATION_BASE_URL` est configuré.

Vérifier le service :

```bash
sudo systemctl status vibration
```

Vérifier Apache :

```bash
sudo apachectl configtest
sudo journalctl -u apache2 -f
```

## 7. Mettre l’application à jour

Compiler la nouvelle version :

```bash
go build -o vibration-server ./cmd/server
```

Installer le nouveau backend :

```bash
sudo systemctl stop vibration
sudo cp vibration-server /opt/vibration/backend/
sudo chown vibration:vibration /opt/vibration/backend/vibration-server
sudo systemctl start vibration
```

Mettre à jour le frontend :

```bash
sudo cp -R web/. /var/www/vibration/web/
sudo chown -R www-data:www-data /var/www/vibration/web
```

Puis effectuer un rechargement forcé dans le navigateur afin d’actualiser le Service Worker.

## 8. Déploiement rapide depuis un poste de développement

Depuis macOS ou Linux, en remplaçant l’hôte si nécessaire :

```bash
cd /Users/jean-pierre/Codex/WebTchat
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -o vibration-server ./cmd/server
scp vibration-server adminroot@192.168.1.62:/tmp/vibration-server
scp -r web adminroot@192.168.1.62:/tmp/web
ssh adminroot@192.168.1.62
```

Puis sur le serveur :

```bash
sudo install -o vibration -g vibration -m 0755 /tmp/vibration-server /opt/vibration/backend/vibration-server
sudo rm -rf /var/www/vibration.appbox.fr/web/*
sudo cp -R /tmp/web/. /var/www/vibration.appbox.fr/web/
sudo chown -R www-data:www-data /var/www/vibration.appbox.fr/web
sudo systemctl restart vibration
sudo systemctl reload apache2
```

Contrôles rapides :

```bash
curl -i http://127.0.0.1:18080/api/registration
curl -i https://vibration.appbox.fr/api/registration
curl -I https://vibration.appbox.fr/icons/group.svg
```

## 9. Dépannage Apache

Si le frontend s’affiche mais que `/api/me` ou `/api/login` répondent `404`, Apache ne proxy pas `/api/` dans le vhost HTTPS actif. Vérifier :

```bash
sudo apachectl -S
sudo grep -R "vibration.appbox.fr\|DocumentRoot\|ProxyPass" /etc/apache2/sites-enabled /etc/apache2/sites-available
sudo ss -ltnp | grep 18080
curl -i http://127.0.0.1:18080/api/registration
```

Si `/icons/group.svg` ou `/icons/person.svg` répondent `404` alors que les fichiers existent, vérifier l’alias global Apache :

```bash
sudo grep -R "Alias /icons" /etc/apache2
```

Sur Debian/Ubuntu, `/etc/apache2/mods-enabled/alias.conf` contient souvent :

```apache
Alias /icons/ "/usr/share/apache2/icons/"
```

Dans ce cas, ajouter l’alias `/icons/` dans le vhost de Vibration comme montré plus haut, puis recharger Apache.

## 10. Sauvegardes

En édition Enterprise, l’onglet **Administration > Base de données** crée des archives logiques dans `/var/lib/vibration/backups`. Elles peuvent être téléchargées sans exposer la chaîne de connexion. Chaque restauration et remise à zéro crée automatiquement une archive de secours avant de modifier les données.

Pour activer ces deux actions destructrices après validation en préproduction, le compte système `vibration` doit pouvoir redémarrer uniquement son propre service. Par exemple, ajouter avec `visudo` une règle strictement limitée :

```sudoers
vibration ALL=(root) NOPASSWD: /usr/bin/systemctl restart vibration.service
```

Puis ajouter au service :

```ini
Environment="SERVICE_RESTART_COMMAND=/usr/bin/sudo -n /usr/bin/systemctl restart vibration.service"
Environment=ALLOW_DATABASE_DESTRUCTIVE_ACTIONS=true
```

Exécuter `sudo systemctl daemon-reload` puis `sudo systemctl restart vibration`. Le mot de passe administrateur et une phrase saisie exactement restent exigés dans l’interface. Si cette délégation `sudoers` n’est pas souhaitée, conserver `ALLOW_DATABASE_DESTRUCTIVE_ACTIONS=false` : la création et le téléchargement des sauvegardes continuent de fonctionner.

Ces archives contiennent les données de l’application, mais pas `app_secret` ni les clés VAPID. Elles complètent donc, sans la remplacer, la sauvegarde complète suivante.

Sauvegarder régulièrement :

```text
/var/lib/vibration/chat.db
/var/lib/vibration/app_secret
/var/lib/vibration/vapid.json
```

Exemple :

```bash
sudo systemctl stop vibration
sudo tar -czf vibration-backup.tar.gz /var/lib/vibration
sudo systemctl start vibration
```

Conserver ces sauvegardes dans un emplacement protégé. La perte de `app_secret` ou des clés VAPID peut invalider certaines sessions ou notifications existantes.
