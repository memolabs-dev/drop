# Publier l'app de bureau : macOS, Windows et Linux

Ce document décrit comment sortir une version de l'app drop pour les trois systèmes (T3.4, T3.7, T3.8), ce que contient chaque paquet, ce qui est signé et comment un testeur l'installe. Les détails propres au Mac (notarisation depuis un Mac, mises à jour signées, retour arrière, recette T3.4) restent dans [MAC_RELEASE](MAC_RELEASE.md).

Une build réussie en CI ne qualifie pas un paquet : la recette sur de vraies machines reste à faire (voir « Reste à faire »).

## Ce que contient l'app

La même coque Tauri 2 (`apps/desktop/src-tauri`) sert les trois systèmes. Chaque paquet embarque :

- le runtime Node officiel du système et de l'architecture visés (`node`, ou `node.exe` sous Windows) : l'app marche sans Node installé ;
- `drop.mjs` (le Node de drop, interface React comprise) et `drop-mcp.mjs`, produits par `scripts/bundle.ts` ;
- `drop-iroh` (`drop-iroh.exe` sous Windows), compilé pour la cible, placé à côté du Node où celui-ci le cherche, avec ses notices de licence.

Ce qui change d'un système à l'autre vit dans `tauri.macos.conf.json`, `tauri.windows.conf.json` et `tauri.linux.conf.json`, que Tauri fusionne avec `tauri.conf.json` (format des paquets, nom des programmes embarqués). Le nom du produit (`drop`) et l'identifiant (`dev.memolabs.drop`) ne changent pas.

## Construire sur sa machine

Il faut Node 22 ou plus récent, Rust et, selon le système, Xcode (macOS), les outils de build C++ de Visual Studio (Windows) ou les paquets WebKitGTK listés dans la doc Tauri (Linux). Le script embarque le Node qui le lance : il construit donc pour la machine où il tourne, jamais pour une autre.

```sh
node scripts/build-desktop.ts --debug              # essai, n'importe quel système
node scripts/build-desktop.ts --release            # Windows ou Linux
node scripts/build-desktop.ts --release --unsigned # macOS sans identité Apple (signature ad hoc)
```

`node scripts/build-mac.ts` reste un alias de `build-desktop.ts --platform macos`. Les paquets et un manifeste de leurs empreintes SHA-256 arrivent dans `dist/desktop/`.

## Sortir une version

1. Monter `version` dans `apps/desktop/src-tauri/tauri.conf.json` (trois nombres `x.y.z` : l'installeur MSI n'accepte pas de suffixe). Faire passer ce changement par une PR, puis la fusionner.
2. Sur le commit fusionné de `main`, créer et pousser le tag :
   ```sh
   git tag v0.2.0
   git push origin v0.2.0
   ```
3. Le workflow `release desktop` (`.github/workflows/release.yml`) refuse un tag qui ne correspond pas à la version, construit les cinq paquets, ouvre chacun comme le ferait un testeur (test de fumée) puis crée une **release en brouillon** avec les installeurs, `SHA256SUMS.txt` et une attestation de provenance par fichier.
4. Relire le brouillon sur GitHub (Releases), essayer au moins un paquet, puis cliquer « Publish release ». Rien n'est publié sans ce clic.

Pour essayer le circuit sans tag : onglet Actions, « release desktop », « Run workflow ». Le brouillon s'appelle alors `v<version>-ci.<numéro>` et reste une préversion ; le tag n'existe que si quelqu'un publie ce brouillon. Supprimer ces brouillons d'essai une fois relus.

Une PR qui touche la coque, ses scripts de build ou `drop-iroh` lance les mêmes builds et tests de fumée, sans release : les paquets restent 14 jours dans les artefacts du run.

## Les fichiers d'une release

| Fichier                                             | Système                        | Ce que c'est                                                          |
| --------------------------------------------------- | ------------------------------ | --------------------------------------------------------------------- |
| `drop_<version>_aarch64.dmg`                        | macOS 13 ou plus, Apple Silicon | Image disque avec `drop.app`                                         |
| `drop_<version>_x64.dmg`                            | macOS 13 ou plus, Intel         | Image disque avec `drop.app`                                         |
| `drop_<version>_x64-setup.exe`                      | Windows 10 et 11, x64           | Installeur NSIS, pour l'utilisateur courant, sans droits administrateur |
| `drop_<version>_x64_en-US.msi`                      | Windows 10 et 11, x64           | Paquet MSI, pour un déploiement géré par un administrateur            |
| `drop_<version>_amd64.AppImage`                     | Linux x64                       | Programme autonome, sans installation                                 |
| `drop_<version>_amd64.deb`                          | Debian, Ubuntu x64              | Paquet Debian                                                         |
| `drop_<version>_aarch64.AppImage`, `drop_<version>_arm64.deb` | Linux arm64            | Les mêmes pour ARM 64 bits                                            |
| `drop-build-manifest-<système>-<arch>.json`         | tous                            | Version, version de Node, empreintes des programmes embarqués, niveau de signature |
| `SHA256SUMS.txt`                                    | tous                            | Empreinte SHA-256 de chaque fichier                                   |

Vérifier un fichier téléchargé :

```sh
sha256sum -c SHA256SUMS.txt --ignore-missing           # Linux ; macOS : shasum -a 256 -c
gh attestation verify drop_0.2.0_amd64.deb -R memolabs-dev/drop
```

Sous Windows : `Get-FileHash .\drop_0.2.0_x64-setup.exe` puis comparer avec la ligne de `SHA256SUMS.txt`.

## Signature, par système

| Système | Sans secret (état actuel)                                                                 | Avec les secrets                                    |
| ------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------- |
| macOS   | Signature ad hoc, non notarisée : macOS demande une autorisation à la première ouverture | Developer ID et notarisation Apple, ticket agrafé   |
| Windows | Non signé : SmartScreen avertit au premier lancement                                       | Installeurs et `drop-desktop.exe` signés Authenticode |
| Linux   | Non signé, comme la plupart des AppImage et des `.deb` hors dépôt                           | Sans objet                                          |

Dans tous les cas, `SHA256SUMS.txt` et les attestations de provenance (signées par GitHub, Sigstore) prouvent que le fichier sort de ce dépôt et de ce workflow.

La build notarisée faite sur le Mac de Guillaume (MAC_RELEASE) reste possible et prioritaire tant que les secrets Apple ne sont pas dans GitHub.

### Secrets à ajouter (Settings, Secrets and variables, Actions)

macOS, signature et notarisation (les six sont requis, sinon la build reste ad hoc) :

| Secret                        | Contenu                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------- |
| `APPLE_CERTIFICATE`           | Le certificat « Developer ID Application » exporté en `.p12`, encodé en base64 (`base64 -i cert.p12`) |
| `APPLE_CERTIFICATE_PASSWORD`  | Le mot de passe choisi à l'export du `.p12`                                                  |
| `APPLE_SIGNING_IDENTITY`      | Le nom exact de l'identité, par exemple `Developer ID Application: Guillaume Flambard (Q52VN4UT34)` |
| `APPLE_API_ISSUER`            | L'« Issuer ID » affiché dans App Store Connect, Users and Access, Integrations, Keys          |
| `APPLE_API_KEY`               | Le « Key ID » de la clé API créée au même endroit (rôle Developer suffit)                     |
| `APPLE_API_PRIVATE_KEY`       | Le contenu du fichier `AuthKey_<KeyID>.p8` téléchargé à la création de la clé               |

Le trousseau temporaire de la CI reçoit un mot de passe aléatoire à chaque run : pas de secret à prévoir pour lui.

Windows, signature Authenticode (les deux sont requis) :

| Secret                          | Contenu                                                   |
| ------------------------------- | --------------------------------------------------------- |
| `WINDOWS_CERTIFICATE`           | Le certificat de signature de code en `.pfx`, encodé en base64 |
| `WINDOWS_CERTIFICATE_PASSWORD`  | Le mot de passe du `.pfx`                                 |

Le serveur d'horodatage par défaut est `http://timestamp.digicert.com` (`WINDOWS_TIMESTAMP_URL` le change). Un certificat neuf, même signé, garde un avertissement SmartScreen jusqu'à ce qu'il gagne une réputation ; depuis 2024 un certificat EV n'y échappe plus non plus (doc Tauri). Les certificats délivrés après juin 2023 vivent sur un module matériel ou dans un service en ligne (Azure Artifact Signing, par exemple) : il faudra alors passer par `signCommand` au lieu d'un `.pfx`. Même signé, `drop-iroh.exe` ne l'est pas encore (reste à faire).

## Installer, par système

### macOS (13 Ventura ou plus récent)

1. Ouvrir le `.dmg` de son architecture (menu Pomme, « À propos de ce Mac » : puce Apple ou Intel).
2. Glisser `drop` dans Applications, puis l'ouvrir depuis Applications.
3. Build ad hoc seulement : macOS refuse la première ouverture. Ouvrir Réglages Système, Confidentialité et sécurité, puis « Ouvrir quand même » en face de drop, et confirmer.

L'icône de goutte apparaît dans la barre des menus : clic pour le panneau.

### Windows 10 et 11

1. Lancer `drop_<version>_x64-setup.exe`. Sans signature, SmartScreen affiche « Windows a protégé votre ordinateur » : cliquer « Informations complémentaires », puis « Exécuter quand même ».
2. L'installation se fait pour l'utilisateur courant, dans `%LOCALAPPDATA%\drop`, sans droits administrateur. Si WebView2 manque (rare sur Windows 10 à jour, toujours présent sur Windows 11), l'installeur le télécharge : il faut alors Internet.
3. drop démarre avec la session. L'icône est dans la zone de notification, à droite de la barre des tâches (parfois derrière la flèche « Afficher les icônes cachées ») : clic gauche pour le panneau, clic droit pour le menu.

Le `.msi` sert à un administrateur qui déploie sur plusieurs postes ; il installe pour toute la machine.

### Linux (x64 ou arm64, X11 ou Wayland)

AppImage, sans installation :

```sh
chmod +x drop_<version>_amd64.AppImage
./drop_<version>_amd64.AppImage
```

Une AppImage demande FUSE 2 : `sudo apt install libfuse2` sur Ubuntu 22.04 et Debian 12, `libfuse2t64` sur Ubuntu 24.04. La build vise Ubuntu 22.04 et toute distribution aussi récente (glibc 2.35).

Paquet Debian ou Ubuntu : `sudo apt install ./drop_<version>_amd64.deb` (apt installe WebKitGTK et la bibliothèque d'icône).

L'icône s'affiche dans la barre du bureau par le protocole AppIndicator : KDE, Xfce, Cinnamon et Ubuntu l'affichent d'emblée ; GNOME de base demande l'extension « AppIndicator and KStatusNotifierItem Support ». Sous Linux, l'icône n'émet pas de clic (doc Tauri) : tout passe par son menu, « Ouvrir le panneau », « Ouvrir mon espace », « Réessayer le démarrage », « Quitter ». Le panneau s'ouvre alors au milieu de l'écran, dans une petite fenêtre normale.

## Même comportement partout

- **Menu de l'icône** : « Ouvrir le panneau », « Ouvrir mon espace », « Réessayer le démarrage », « Quitter », plus « Mettre à jour vers x.y.z » sur une build Mac à mises à jour.
- **Démarrage avec la session** (build de release seulement) : élément d'ouverture sur macOS, clé `Run` de l'utilisateur sous Windows, entrée `~/.config/autostart` sous Linux (le chemin de l'AppImage quand l'app en vient). Désactivable dans les réglages du système.
- **Une seule instance** sous Windows et Linux : relancer l'app, ou ouvrir un lien `drop://` pendant qu'elle tourne, passe la main à l'instance déjà ouverte, qui montre son panneau. Jamais deux daemons.
- **Liens `drop://`** : enregistrés à l'installation par le `.dmg` (macOS), le `.deb`, l'installeur NSIS et le `.msi`. Une AppImage les enregistre pour l'utilisateur à chaque lancement (`~/.local/share/applications/drop-desktop-handler.desktop`, masqué des menus, par `register_all` du plugin deep-link) ; un échec va dans `~/.drop/app.log` avec `E_DEEP_LINK` (T4.31).
- **Le daemon meurt avec l'app** sur les trois systèmes, même si l'app est tuée : il lit un tube que seule l'app tient ouvert (T4.18). Le test `packages/node/test/lifecycle.test.ts` tue le processus parent sur Linux, Windows et macOS en CI ; le test de fumée de chaque paquet le vérifie avec le Node embarqué.
- **Fermer le panneau** (Alt+F4, bouton de la barre de titre sous Linux) le cache seulement ; seul « Quitter » arrête drop.
- Les données restent dans `~/.drop` (`%USERPROFILE%\.drop` sous Windows), comme pour `drop` en ligne de commande.

## Reste à faire

- Recette sur de vraies machines : Windows 10 et 11, Ubuntu GNOME et KDE, X11 et Wayland, Mac Intel. Installer, ouvrir le panneau depuis l'icône, redémarrer la session, tuer l'app depuis le gestionnaire de tâches et vérifier que le daemon s'arrête.
- Windows : notifications natives (le daemon les passe à l'app, qui ne les affiche que sur macOS), droits du dossier `.drop` (le mode `0600` ne vaut rien sous Windows, il faut des ACL), signature de `drop-iroh.exe`.
- Linux : notifications natives ; recette du lien `drop://join` avec une AppImage et un `.deb` (T4.31).
- Mises à jour signées pour Windows et Linux (aujourd'hui macOS seulement).
- Ajouter les secrets de signature, puis refaire une release.

## Sources lues le 11 octobre 2026

- Tauri 2, GitHub Actions : https://v2.tauri.app/distribute/pipelines/github/
- Tauri 2, prérequis (paquets Linux, WebView2) : https://v2.tauri.app/start/prerequisites/
- Tauri 2, installeur Windows (NSIS, MSI, WebView2) : https://v2.tauri.app/distribute/windows-installer/
- Tauri 2, signature Windows : https://v2.tauri.app/distribute/sign/windows/
- Tauri 2, signature et notarisation macOS, signature ad hoc : https://v2.tauri.app/distribute/sign/macos/
- Tauri 2, AppImage et Debian : https://v2.tauri.app/distribute/appimage/ et https://v2.tauri.app/distribute/debian/
- Tauri 2, icône système (pas de clic sous Linux) : https://v2.tauri.app/learn/system-tray/
- Tauri 2, configuration par plateforme : https://v2.tauri.app/develop/configuration-files/
- Tauri 2, liens profonds et instance unique : https://v2.tauri.app/plugin/deep-linking/ et https://v2.tauri.app/plugin/single-instance/
- tauri-action : https://github.com/tauri-apps/tauri-action
- Runners GitHub : https://docs.github.com/en/actions/reference/runners/github-hosted-runners
