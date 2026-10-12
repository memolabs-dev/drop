# site Specification

## Purpose

Le site présente drop à quelqu'un qui n'a jamais vu le dépôt : ce que ça fait, comment démarrer, à quoi ça sert, ce
que ça protège, et où en est le projet (T2.6, D72). Il est servi sur `drop.memolabs.dev` par l'image drop, à côté du
relais et de la passerelle, et sert aussi les fichiers de mise à jour de l'app Mac (D70). Il ne contient aucun script, sauf la page pour rejoindre une équipe (T4.23, D95).

## Requirements

### Requirement: Pages publiques

Le site SHALL comprendre l'accueil, « Démarrer en 5 minutes », les cas d'usage, la sécurité, le guide et l'avancement,
reliés entre eux. Chaque lien interne MUST mener à une page ou une ancre existante, et chaque image MUST avoir un texte
alternatif. Seuls les fichiers d'une liste explicite sont publiés : jamais le dépôt entier.

#### Scenario: Liens et images

<!-- openspec-guard:test="documentation site > serves every page, their local links and anchors, and all image alternatives" -->

- **WHEN** on parcourt chaque page publiée
- **THEN** chaque lien interne répond, chaque ancre existe, et chaque image a un attribut `alt`

#### Scenario: Surface limitée

<!-- openspec-guard:test="documentation site > serves only the selected public assets and refuses traversal, mutations and invalid encodings" -->

- **WHEN** on demande un fichier du dépôt, un chemin qui remonte, une méthode autre que GET ou HEAD, ou un autre hôte
- **THEN** le site répond 404, 405 ou 403 selon le cas

### Requirement: Installation selon l'ouverture

`site/site.json` SHALL fixer `installs` (`beta` ou `open`) et `contact`. En `beta`, l'accueil MUST proposer de demander
un accès (un lien `mailto:` si `contact` est une adresse, sinon un texte) et MUST NOT contenir de lien de
téléchargement. En `open`, il MUST proposer l'app Mac (`downloads/drop.dmg`), le paquet Claude Desktop
(`downloads/drop.mcpb`) et les guides de connexion des agents et des assistants. Une adresse de contact invalide MUST
faire échouer la construction (`E_SITE_CONTACT`).

#### Scenario: Bêta

<!-- openspec-guard:test="documentation site > during the beta, offers to ask for access and links no download (T2.6)" -->

- **WHEN** le site est construit avec `installs: beta`
- **THEN** l'accueil propose de demander un accès et aucune page ne pointe vers un `.dmg`, un `.mcpb` ou un lien `cursor://`

#### Scenario: Ouvert

<!-- openspec-guard:test="documentation site > once open, links the Mac app, the Claude Desktop bundle and the connector address (T2.6)" -->

- **WHEN** le site est construit avec `installs: open`
- **THEN** l'accueil pointe vers `downloads/drop.dmg` et `downloads/drop.mcpb`, et « Démarrer » donne l'adresse du connecteur

### Requirement: Service public

`node scripts/site.ts serve` SHALL servir le site sur l'hôte public configuré (`SITE_PUBLIC_HOST`, 403 sinon), avec la
politique de contenu de la prévisualisation et `Strict-Transport-Security`. Il MUST servir depuis `SITE_RELEASES_DIR`,
par nom exact seulement : `/updates/latest.json` (sans cache), `/updates/drop-<version>-darwin-aarch64.app.tar.gz`,
`/downloads/drop.dmg` et `/downloads/drop.mcpb`. Tout autre nom MUST répondre 404.

#### Scenario: Fichiers de release

<!-- openspec-guard:test="documentation site > serves the public site on its own host with release files by exact name only (T2.6)" -->

- **WHEN** le dossier des releases contient le manifeste, une archive, l'image disque et un autre fichier
- **THEN** les trois premiers sont servis sous leur adresse, l'autre fichier, un chemin qui remonte ou un nom absent répondent 404

### Requirement: Page pour rejoindre
Le site SHALL servir `/join`, seule page à script : un script en ligne épinglé par son empreinte dans la CSP, `connect-src 'none'`, aucune ressource d'un autre site. Il SHALL lire l'invitation dans le fragment, afficher qui invite comme texte, proposer d'abord le téléchargement du système détecté, un bouton vers `drop://join?invite=<code>` et le code à copier, ou expliquer un lien inutilisable. Il MUST NOT transmettre l'invitation. Les autres pages gardent `script-src 'none'`.

#### Scenario: AC: politique de la page
<!-- openspec-guard:test="join page (T4.23) > serves /join under a policy that pins its one script and allows no connection, other pages keep none" -->
- **WHEN** on demande `/join` et ses variantes
- **THEN** la CSP épingle l'empreinte du seul script, interdit toute connexion et tout formulaire, la page ne charge rien d'ailleurs, et « Démarrer » garde `script-src 'none'`

#### Scenario: AC: rien ne sort de la page
<!-- openspec-guard:test="join page (T4.23) > never sends the invite anywhere and writes names as text only" -->
- **WHEN** on lit le script de la page
- **THEN** il n'appelle ni `fetch`, ni `XMLHttpRequest`, ni `WebSocket`, ni `sendBeacon`, n'écrit pas de HTML et n'ouvre aucune autre adresse

#### Scenario: AC: invitation affichée et bouton
<!-- openspec-guard:test="join page (T4.23) > shows who invites, offers the matching download, opens drop://join and drops the fragment" -->
- **WHEN** un PC Windows ouvre le lien d'une invitation de Guillaume pour l'équipe Atelier
- **THEN** la page affiche « Guillaume t'invite dans l'équipe Atelier », propose Windows en premier, pointe le bouton vers `drop://join?invite=<code>`, retire le fragment de l'adresse et retrouve l'invitation après rechargement

#### Scenario: AC: lien inutilisable expliqué
<!-- openspec-guard:test="join page (T4.23) > explains an incomplete, unreadable or expired link instead of a join button" -->
- **WHEN** le lien n'a pas de fragment, un fragment trop court, illisible ou une invitation expirée
- **THEN** la page l'explique, masque les étapes et le bouton ne mène nulle part ; un nom piégé est affiché nettoyé, comme texte

### Requirement: Fichier de release contrôlé par le descripteur envoyé
Le site public SHALL ouvrir un fichier de release avant de le contrôler, puis lire son type et sa taille par ce descripteur et n'envoyer que la longueur annoncée. Un dossier ou un tube nommé portant un nom de release MUST répondre 404 sans attendre.

#### Scenario: AC: dossier et tube refusés sans attente
<!-- openspec-guard:test="documentation site > checks a release through the handle it sends, answers 404 for a directory or a pipe and never waits on one (T4.26)" -->
- **WHEN** le dossier des releases contient `latest.json`, un `drop.dmg` vide, un dossier et un tube nommé aux noms de releases
- **THEN** `latest.json` est servi avec sa longueur en GET et en HEAD, le fichier vide avec une longueur 0, le dossier, le tube et une release absente répondent 404

### Requirement: Politique de la page pour rejoindre pour un hébergement statique
`node scripts/site.ts build` SHALL écrire, à côté du dossier exporté et jamais dedans, `site-headers.json` : la politique de contenu par défaut et, pour chaque chemin de la page pour rejoindre (`/join`, `/join/`, `/join.html`, `/join/index.html`), la politique à envoyer en en-tête, celle que `serve` envoie, `frame-ancestors 'none'` compris. Un hébergement statique MUST pouvoir l'appliquer sans recalculer l'empreinte du script (T4.31).

#### Scenario: AC: politique exportée hors des fichiers publiés
<!-- openspec-guard:test="join page (T4.31) > writes the join page policy next to the static export, outside the published files" -->
- **WHEN** le site est construit dans un dossier
- **THEN** `site-headers.json` est écrit à côté de ce dossier, donne pour chaque chemin de `/join` la politique que `serve` envoie et pour le reste `script-src 'none'`, et aucun fichier publié ne le contient
