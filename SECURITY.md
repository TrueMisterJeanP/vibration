# Politique de sécurité

Vibration est conçu pour l’auto-hébergement et l’auditabilité. L’édition
Community est volontairement limitée afin de permettre aux visiteurs d’inspecter
et de tester la philosophie centrale du projet : chiffrement côté navigateur,
petit serveur Go, stockage SQLite et absence de plan de contrôle Vibration
hébergé.

## Signaler une vulnérabilité

N’ouvrez pas d’issue publique pour une vulnérabilité présumée avant qu’elle ait
été qualifiée.

Envoyez un signalement privé au mainteneur du projet avec :

- la version ou le commit concerné ;
- le mode de déploiement et le système d’exploitation ;
- des étapes de reproduction claires ;
- l’impact attendu et l’impact observé ;
- des journaux ou captures si nécessaire, sans partager de clefs privées ni de
  contenu réel de messages.

Si aucun contact de sécurité privé n’est publié dans le dépôt, contactez le
mainteneur via le site officiel de Vibration avant toute divulgation publique.

## Périmètre de sécurité pris en compte

Les correctifs de sécurité sont priorisés pour :

- l’authentification et la gestion des sessions ;
- les flux de chiffrement côté navigateur et de stockage local des clefs ;
- l’exposition des métadonnées de messages, fichiers et appels ;
- l’autorisation WebSocket ;
- l’autorisation d’envoi et de téléchargement de fichiers ;
- la minimisation du contenu des notifications push ;
- les vulnérabilités de dépendances ayant un impact pratique sur Community.

L’édition Community n’inclut pas la console d’administration Enterprise, la
fédération, la configuration Coturn privée, les hooks de redémarrage administré,
les options de déploiement sur base externe, ni le wrapper desktop/mobile Tauri.

## Modèle de sécurité

Vibration cherche à minimiser la confiance accordée au serveur :

- le contenu des messages, les métadonnées de fichiers et les données de
  conversation sont chiffrés dans le navigateur avant d’être envoyés au serveur ;
- le serveur stocke et route des charges chiffrées, sans être censé lire le
  contenu clair des messages ;
- les notifications Web Push évitent volontairement le contenu clair ;
- Community utilise par défaut un stockage local SQLite ;
- aucun service d’analytique ou de télémétrie hébergé par Vibration n’est requis.

Ce modèle ne supprime pas toutes les frontières de confiance. L’opérateur
contrôle toujours :

- le binaire serveur déployé et les fichiers web statiques ;
- la terminaison TLS et la configuration du reverse proxy ;
- les sauvegardes et permissions du système de fichiers ;
- les fichiers de base de données et les journaux serveur ;
- les secrets applicatifs et les clefs VAPID.

## Liste de durcissement

Pour un test auto-hébergé proche de la production :

- servez l’application en HTTPS ;
- activez `SECURE_COOKIES=true` derrière un reverse proxy HTTPS correctement
  configuré ;
- gardez `data/app_secret` et `data/vapid.json` privés ;
- limitez les permissions du dossier `data/` ;
- sauvegardez ensemble `data/chat.db`, `data/app_secret` et les clefs VAPID ;
- maintenez à jour l’outil Go et le système d’exploitation ;
- utilisez Go 1.26.5 ou une version corrective ultérieure ; les versions plus
  anciennes sont refusées par le module ;
- relisez `DEPENDENCIES.md` et `THIRD_PARTY_NOTICES.md` avant redistribution ;
- ne publiez pas `.env`, certificats, clefs privées, bases de données ou
  binaires locaux.

## Revue des dépendances

Avant de publier une version Community :

```bash
GOCACHE=/tmp/webtchat-go-cache go test -count=1 -tags community ./...
GOCACHE=/tmp/webtchat-go-cache go vet -tags community ./...
npm ci
npm run check:js
```

Les licences et le périmètre des dépendances sont documentés dans :

- [DEPENDENCIES.md](DEPENDENCIES.md)
- [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
- [COMMUNITY_VS_ENTERPRISE.md](COMMUNITY_VS_ENTERPRISE.md)
