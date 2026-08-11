# Community et Enterprise

Vibration Community est l’édition publique GitHub. Son objectif est de permettre
aux visiteurs d’inspecter, d’exécuter et de tester la philosophie de Vibration :
auto-hébergement souverain, chiffrement côté navigateur et principaux flux de
messagerie sans dépendre d’un service Vibration hébergé.

Vibration Enterprise conserve le même socle de code et ajoute des fonctions
opérationnelles pour les organisations qui ont besoin de production, de support,
d’administration et d’un accompagnement d’auto-hébergement.

## Résumé

Le tableau comparatif complet des fonctionnalités est publié directement dans le [README](README.md#comparatif-community-et-enterprise). Les différences structurantes sont les suivantes :

| Domaine | Community | Enterprise |
| --- | --- | --- |
| Licence | GPL-3.0-or-later | GPL-3.0-or-later pour le code livré au client |
| Accès au code | Export public GitHub | Code de la version livré au client |
| Client | Web et PWA | Web, PWA et interfaces Enterprise ; packaging Tauri selon le déploiement |
| Base de données | SQLite uniquement | SQLite, MariaDB/MySQL et PostgreSQL |
| Inscriptions | Ouvertes lorsque l’instance est publique | Configurables avec code d’activation et invitations |
| Administration | Non incluse | Console complète, panneau gestionnaire, rôles, modération et audit |
| Appels dans une même instance | Audio/vidéo, partage d’écran et tableau blanc | Identique |
| Appels entre instances | Non fédérés | `federated-calls-v1` entre instances approuvées |
| Groupes fédérés | Non inclus | Plusieurs participants locaux et un participant distant |
| Fédération des autres fonctions | Non incluse | Messages, fichiers, réactions, épingles, accusés, présence, saisie, sondages et évènements |
| TURN/Coturn | STUN public de secours uniquement | Coturn privé configurable et testable |
| Exploitation des données | Sauvegarde manuelle de SQLite | Migration, recopie, sauvegarde, restauration et remise à zéro protégée |
| Support | Communauté et exploitation autonome | Support commercial et accompagnement de déploiement |

## Inclus dans Community

- inscription et connexion des utilisateurs ;
- contacts ;
- conversations privées et groupes ;
- messages chiffrés côté navigateur ;
- enveloppes d’identité Argon2id avec migration des anciens comptes PBKDF2 ;
- empreintes d’identité persistantes et signatures individuelles des nouveaux messages ;
- fichiers chiffrés ;
- sondages à durée limitée ;
- évènements et calendrier global des discussions ;
- dossier global des fichiers avec aperçus ;
- liens temporaires et révocables de partage de fichiers ;
- acceptation des conditions d’utilisation après l’inscription ;
- appels audio/vidéo via les API WebRTC du navigateur ;
- partage d’écran lorsque le navigateur le permet ;
- tableau blanc ;
- notifications Web Push sans contenu clair ;
- installation PWA depuis le navigateur ;
- persistance SQLite ;
- script d’export public reproductible.

## Non inclus dans Community

- wrapper desktop/mobile `src-tauri/` ;
- console d’administration ;
- enregistrement des routes Enterprise ;
- modules de fédération ;
- configuration Coturn privée ;
- workflow de code d’activation ;
- support public du déploiement sur base externe ;
- support de production administré.

L’export Community exclut ces fichiers via `editions/community.exclude`.

## Pourquoi cette séparation existe

Community doit rester assez simple pour être auditée et lancée localement. Elle
démontre les principes du produit sans transformer le dépôt public en package
complet d’exploitation commerciale.

Enterprise s’adresse aux organisations qui ont besoin de garanties de
production plus fortes : administration, assistance de déploiement,
infrastructure de relais privée, options de fédération et choix de base de
données.

## Positionnement public

Community doit être présentée comme :

- auditable ;
- auto-hébergeable ;
- souveraine par défaut ;
- centrée sur l’expérience utilisateur principale ;
- volontairement limitée par rapport à Enterprise.

Elle ne doit pas être présentée comme l’édition complète d’exploitation en
production.

Offre Enterprise : https://vibration-shop.appbox.fr
