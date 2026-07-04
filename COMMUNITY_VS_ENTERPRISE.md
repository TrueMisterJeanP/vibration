# Community et Enterprise

Vibration Community est l’édition publique GitHub. Son objectif est de permettre
aux visiteurs d’inspecter, d’exécuter et de tester la philosophie de Vibration :
auto-hébergement souverain, chiffrement côté navigateur et principaux flux de
messagerie sans dépendre d’un service Vibration hébergé.

Vibration Enterprise conserve le même socle de code et ajoute des fonctions
opérationnelles pour les organisations qui ont besoin de production, de support,
d’administration et d’un accompagnement d’auto-hébergement.

## Résumé

| Domaine | Community | Enterprise |
| --- | --- | --- |
| Licence | GPL-3.0-or-later | GPL-3.0-or-later pour le code livré au client |
| Accès au code | export public GitHub | livré aux clients pour leur version |
| Objectif principal | auditer et tester la philosophie et les fonctions centrales | déploiement de production et contrôle opérationnel |
| Serveur | serveur Go | serveur Go avec modules supplémentaires |
| Client web | web/PWA | web/PWA avec interfaces Enterprise |
| Wrapper desktop/mobile | non publié | peut inclure le packaging Tauri/Android |
| Base de données | SQLite uniquement | SQLite et options de déploiement sur base externe |
| Inscription | inscriptions ouvertes | peut inclure activation et administration |
| Console d’administration | non incluse | incluse |
| Fédération | non incluse | disponible si configurée |
| TURN/Coturn | STUN public de secours uniquement | configuration Coturn privée |
| Support | communauté / autonome | support commercial et accompagnement de déploiement |

## Inclus dans Community

- inscription et connexion des utilisateurs ;
- contacts ;
- conversations privées et groupes ;
- messages chiffrés côté navigateur ;
- fichiers chiffrés ;
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
