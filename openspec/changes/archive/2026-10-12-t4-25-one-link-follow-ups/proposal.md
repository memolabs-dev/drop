## Why

T4.23 (D95) a livré le lien unique `https://drop.memolabs.dev/join#<invitation>`, mais laissé ses suites dans la ligne T4.31 :

- le panneau React de la barre de menus (T4.24, D97) donne encore `drop://pair?code=…` à « Inviter », un lien qui ne marche que si l'invité a déjà drop, alors que `POST /ui/invite` renvoie déjà `link`, le lien https de la page pour rejoindre ;
- après « Rejoindre », `POST /ui/pair` répond `next: 'connect_agents'`, mais le panneau n'en fait rien : l'invité arrive sur l'onglet Équipe sans être conduit à « Connecter mes agents », la troisième étape du parcours de D84 (« un clic pour détecter, raccorder et paramétrer ses agents ») ;
- sous Windows et Linux, un lien `drop://` lance un nouveau processus. La PR #45 (D90) a ajouté `tauri-plugin-single-instance` avec sa fonction `deep-link`, enregistré en premier : un lien ouvert pendant que l'app tourne arrive bien à l'instance déjà ouverte. Il reste un trou, noté dans `docs/RELEASE.md` : une AppImage n'est pas installée, rien n'enregistre donc `drop://` auprès du bureau, et le bouton de la page ne fait rien (doc Tauri « Deep Linking » : le lien n'est enregistré qu'à l'installation, une AppImage demande un lanceur, et un déplacement du fichier invalide le chemin enregistré) ;
- la page `/join` doit être servie sur le VPS avec sa propre politique de contenu. Le serveur du dépôt le fait (`scripts/site.ts serve`), mais le site en ligne est un export statique servi par nginx depuis le dépôt d'infrastructure, qui envoie `script-src 'none'` partout (constaté le 12 octobre 2026 : `/join` y répond 404 avec cette politique). L'empreinte du script change à chaque modification de la page : l'hébergement statique ne peut pas la deviner.

## What Changes

- **« Inviter » donne le lien https** : le panneau affiche et copie `link` de `POST /ui/invite`, avec ce qu'il fait (installer drop puis l'ouvrir sur l'invitation), et plus jamais `drop://pair`.
- **« Connecter mes agents » après « Rejoindre »** : quand `POST /ui/pair` répond `next: 'connect_agents'`, le panneau montre une carte « Prochaine étape » avec le bouton « Connecter mes agents » et « Plus tard ». Le bouton ouvre « Mes outils » et lance l'analyse locale ; le raccordement reste la seconde confirmation de la spec (« Deux confirmations de raccordement »). Quand le poste a adopté le relais de l'invitation (`relay: 'adopt'`), la carte nomme ce relais.
- **AppImage** : au lancement depuis une AppImage, la coque enregistre `drop://` pour l'utilisateur (`register_all` du plugin deep-link), ce qui suit aussi un fichier déplacé. Un échec est écrit dans `app.log` (`E_DEEP_LINK`) sans empêcher le lancement. Les paquets `.deb`, NSIS et MSI enregistrent déjà le schéma à l'installation (tauri-bundler 2.10.1, `deep_link_protocols`).
- **Politique de `/join` pour l'hébergement statique** : `node scripts/site.ts build` écrit, à côté de l'export et hors des fichiers publiés, `dist/site-headers.json` : la politique par défaut et celle de chaque chemin de la page pour rejoindre, en en-tête complet (avec `frame-ancestors`).

## Capabilities

### Modified Capabilities

- `owner-app` : invitation par le lien https dans le panneau, « Connecter mes agents » après « Rejoindre », lien `drop://` vers l'app déjà ouverte sous Windows et Linux et enregistrement de l'AppImage.
- `site` : export de la politique de la page pour rejoindre pour un hébergement statique.

## Non-goals

- **Carte du relais avant « Rejoindre »** : faite à la fusion de T4.24 (D97), la carte nomme le relais quand « Rejoindre » le ferait changer (`relay: 'adopt'`). Elle n'est pas changée ici.
- **Liens directs vers les fichiers de release** : la ligne les conditionne à des noms fixés. Les noms portent la version (`drop_<version>_…`) et aucune release n'est publiée : un lien `releases/latest/download/<nom>` n'a pas de nom stable à viser. Reste ouvert.
- **Configuration nginx du VPS** : elle vit dans le dépôt d'infrastructure privé (D77), hors de ce dépôt. Cette change fournit la politique à y appliquer.
- Enregistrement du schéma en build de développement sous Windows et Linux : il écraserait l'enregistrement de l'app installée sur la machine du développeur.
- La fenêtre « Ton espace » (`views/team.tsx`) : elle donne déjà le lien https.

## Impact

`packages/desktop-ui/src/panel/` (team, deep-links, PanelApp, tools, types), `packages/desktop-ui/test/panel.test.tsx`, module généré du panneau (`scripts/build-desktop-ui.ts`), `apps/desktop/src-tauri/src/main.rs`, `test/desktop-join-link.test.ts`, `scripts/site.ts`, `test/join-page.test.ts`, docs `ONBOARDING.md`, `RELEASE.md`, `deploiement-lab.md`, `site/demarrer.html`. Le Node ne change pas : `link`, `relay` et `next` existent depuis T4.23.
