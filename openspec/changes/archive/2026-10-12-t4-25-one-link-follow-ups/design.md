## Contexte

Ligne T4.31 de `docs/TASKS.md`, nom de change donné par la ligne (`t4-25-one-link-follow-ups`). Décisions lues : D84, D90, D95, D97, D98. Le Node fournit déjà tout ce que le panneau doit montrer : `POST /ui/invite` renvoie `{ code, link, validHours }`, `POST /ui/pair/preview` renvoie `relayHost` et `relay`, `POST /ui/pair` renvoie `{ nodeId, relay, next: 'connect_agents' }` (`packages/node/src/api.ts`).

## Sources lues le 12 octobre 2026, versions installées

- Versions verrouillées : `tauri` 2.12.1, `tauri-plugin-deep-link` 2.6.1, `tauri-plugin-single-instance` 2.5.3 (`apps/desktop/src-tauri/Cargo.lock`) ; `@tauri-apps/cli` 2.12.1 (`scripts/build-desktop.ts`), qui embarque `tauri-bundler` 2.10.1 (dépendances de `tauri-cli` 2.12.1 sur crates.io).
- https://v2.tauri.app/plugin/deep-linking/ : sous Linux et Windows le lien arrive en argument d'un nouveau processus ; `single-instance` avec la fonction `deep-link` doit être le premier plugin ; le lien n'est enregistré qu'à l'installation ; une AppImage demande un lanceur et un déplacement invalide le chemin ; `register_all` enregistre à l'exécution les schémas de la configuration.
- https://v2.tauri.app/plugin/single-instance/ : premier plugin ; D-Bus sous Linux ; Snap et Flatpak demandent une déclaration en plus (drop n'en livre pas).
- Sources des caisses aux versions verrouillées : `tauri-plugin-single-instance` 2.5.3 `src/lib.rs` (avec `deep-link`, le rappel appelle `DeepLink::handle_cli_arguments` avant le nôtre) ; `tauri-plugin-deep-link` 2.6.1 `src/lib.rs` (`handle_cli_arguments` émet `deep-link://new-url`, qu'écoute `on_open_url` ; `register` sous Linux écrit `~/.local/share/applications/<binaire>-handler.desktop` avec `NoDisplay=true` et `Exec` sur le chemin de l'AppImage, puis lance `update-desktop-database` et `xdg-mime default`) ; `tauri-bundler` 2.10.1 (`linux/freedesktop/mod.rs` ajoute `x-scheme-handler/drop` au `.desktop` du `.deb` ; `windows/nsis/installer.nsi` et `windows/msi/main.wxs` enregistrent le protocole à l'installation).

## Ce que la PR #45 a fait, et ce qui restait

Fait par #45 (D90), vérifié dans `main.rs` et `Cargo.toml` : `tauri-plugin-single-instance` 2 avec `deep-link`, cible Windows et Linux, enregistré avant tout autre plugin ; son rappel montre le panneau ; `on_open_url` et `get_current` passent par `open_links`, qui met les liens en file tant que le daemon n'est pas prêt. Les paquets `.deb`, NSIS et MSI enregistrent `drop://` à l'installation.

Restait : l'AppImage, que rien n'installe. Sans lanceur d'AppImage, `xdg-open drop://join?...` ne trouve aucune application.

## Décisions

1. **`register_all` seulement depuis une AppImage** (`app.env().appimage` présent, Linux). Un `.deb` est déjà enregistré par le système ; l'appeler aussi ajouterait une seconde entrée `.desktop` pour le même binaire. À chaque lancement : le chemin suit un fichier déplacé, et `register` ne réécrit le fichier que si `Exec` ou `MimeType` change. Échec (pas de `xdg-mime`, dossier non inscriptible) : `E_DEEP_LINK` dans `app.log`, l'app continue ; le code à copier de la page reste le secours.
2. **Pas d'enregistrement en build de développement** : sous Windows il réécrirait `HKCU\Software\Classes\drop` vers le binaire de debug, et le lien n'ouvrirait plus l'app installée.
3. **« Connecter mes agents » lance l'analyse** : l'analyse est locale et n'écrit rien ; elle compte comme le clic de D84 (« détecter »). Le raccordement reste la seconde action de la spec « Deux confirmations de raccordement ». Le panneau transmet la demande à « Mes outils » par un compteur (`connectRequest`) : l'onglet se charge à l'ouverture, puis lance l'analyse une fois par demande.
4. **La carte « Prochaine étape » n'est pas exclusive** : elle s'affiche au-dessus des onglets, l'onglet Équipe reste ouvert comme avant pour voir l'équipe se remplir. « Plus tard » la ferme.
5. **Lien https seulement** : le panneau et le Node viennent du même `drop.mjs`, aucun Node sans `link` ne peut servir ce panneau ; pas de repli vers `drop://pair`.
6. **`site-headers.json` à côté de l'export** : l'hébergement statique copie le dossier exporté tel quel ; un fichier dedans serait publié. Le fichier est voisin (`dist/site-headers.json` pour `dist/site`). Il porte la politique d'en-tête complète, `frame-ancestors` compris, que la balise `meta` ne peut pas porter.

## Risques

| Risque | Niveau | Traitement |
| --- | --- | --- |
| Les lignes Linux de `main.rs` ne compilent pas sous macOS : `cargo check` local ne les voit pas | moyen | Code écrit contre les signatures lues dans les sources verrouillées (`Manager::env`, `Env::appimage`, `DeepLink::register_all`) ; la CI de release construit Linux. Dit dans la PR. |
| `xdg-mime default` change l'application par défaut de `drop://` pour l'utilisateur | faible | Seul drop déclare ce schéma ; c'est l'effet recherché, comme l'installeur d'un `.deb`. |
| Comportement réel sous Windows et Linux non observé ici | moyen | Scénario manuel non testable, recette au banc maison (T4.6c). |
| Le site en ligne reste sans `/join` tant que le dépôt d'infrastructure n'est pas changé | moyen | Hors de ce dépôt ; signalé comme blocage, politique fournie par l'export. |
