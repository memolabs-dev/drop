# owner-app Specification

## Purpose
L'app Mac rend drop installable par quelqu'un qui n'a jamais ouvert un terminal (T2.4, D26, D30) : une icône dans la
barre de menus, le Node qui tourne en arrière-plan, et un panneau pour décider, voir l'équipe et partager ses outils.
L'app ne porte aucune logique propre : le panneau est servi par le Node local et passe par son API protégée par jeton.

## Requirements

### Requirement: Panneau servi par le Node
Le Node SHALL servir le panneau sur `/app`, seulement avec son jeton : l'interface React compilée hors ligne et intégrée à `drop.mjs`, sous une politique de contenu `default-src 'none'` dont le seul script autorisé est celui de la page, par son empreinte SHA-256 (`script-src 'sha256-…'`), avec `connect-src 'self'` et ni image, ni police, ni formulaire. Aucune ressource externe n'est chargée. Le panneau MUST insérer tout texte venu d'un pair comme texte, jamais comme HTML.

#### Scenario: Jeton exigé
<!-- openspec-guard:test="menu bar panel and its admin routes (T2.4) > serves the panel only with the token, under a CSP that allows nothing but this node" -->
- **WHEN** on demande `/app` sans le jeton, puis avec
- **THEN** la première réponse est 401, la seconde sert le panneau sous cette politique, dont l'empreinte est celle du script servi

#### Scenario: Texte des pairs inerte
<!-- openspec-guard:test="menu bar panel and its admin routes (T2.4) > inserts what peers wrote as text only" -->
- **WHEN** une carte de consentement porte du HTML dans son titre, sa question ou le nom du demandeur
- **THEN** le panneau l'affiche comme du texte

### Requirement: Actions du propriétaire
L'API locale SHALL exposer au panneau, derrière le même jeton : l'état (nom, connexion au relais), les outils détectés
et ceux déjà partagés, partager ou retirer un outil, installer ou retirer drop d'un agent, créer l'équipe, et la liste
des questions envoyées par ce Node.

#### Scenario: Partage et installation depuis le panneau
<!-- openspec-guard:test="menu bar panel and its admin routes (T2.4) > serves the panel only with the token, under a CSP that allows nothing but this node" -->
- **WHEN** le panneau partage `claude_code/figma`, le retire, retire drop de Cursor et crée l'équipe Atlas
- **THEN** chaque action atteint le Node dans cet ordre ; une demande de partage incomplète est refusée (400), une demande sans jeton aussi (401)

### Requirement: App de la barre de menus
L’app SHALL embarquer Node et `drop.mjs`, créer une identité au premier lancement avec un relais local ou explicitement configuré, lancer le daemon et l’arrêter en quittant, y compris quand la coque est tuée. Le panneau et les liens d’appairage restent locaux. Le bootstrap MUST NOT sélectionner de lui-même le relais public : seul le Node, au clic sur « Rejoindre », adopte le relais d’une invitation (D95). Seule la version finale s’inscrit au démarrage de session.

#### Scenario: Premier lancement
<!-- openspec-guard:test="private bundled bootstrap > initializes a fresh private home without starting the imported MCP executable" -->
- **WHEN** l’utilisateur ouvre l’app sur une installation vierge
- **THEN** le bootstrap choisit le profil privé et une destination locale, sans connexion imposée au lab

#### Scenario: AC: pas de daemon orphelin
<!-- openspec-guard:test="daemon lifecycle (T4.18) > AC stops serving when the shell's stdin pipe closes, and only in that mode" -->
- **WHEN** la coque qui a lancé le daemon disparaît sans le quitter
- **THEN** le daemon s’arrête de lui-même et libère son port, alors qu’un `drop serve` lancé hors de l’app continue de tourner

### Requirement: Deux confirmations de raccordement
Le panneau SHALL d'abord montrer l'analyse locale expurgée des adaptateurs connus et laisser choisir ceux à raccorder. Une seconde action explicite SHALL appliquer cette sélection et afficher un résultat par agent. Il MUST distinguer configuration modifiée, relance de l'agent nécessaire et équipe joignable. Sans agent compatible, ou pour un agent non pris en charge, il SHALL montrer une voie de configuration manuelle sans demander de permission générale.

#### Scenario: AC-CONNECT-07 — états de relance et d'équipe distincts
<!-- openspec-guard:test="local agent onboarding (T3.3) > AC-CONNECT-07 reports agent restart independently of team connectivity" -->
- **WHEN** la configuration est raccordée mais l'agent doit redémarrer ou l'équipe est hors ligne
- **THEN** le panneau affiche ces états distincts sans annoncer que le parcours entier est terminé

#### Scenario: AC-CONNECT-08 — état vide et voie manuelle
<!-- openspec-guard:test="local agent onboarding (T3.3) > AC-CONNECT-08 offers a manual stdio entry without broad permissions" -->
- **WHEN** aucun des quatre adaptateurs n'est détecté, ou que l'agent de l'utilisateur n'est pas pris en charge
- **THEN** le panneau propose la configuration manuelle et n'élargit aucune permission

### Requirement: Invitation confirmée avant appairage
Ouvert par un lien `drop://pair` ou `drop://join` (T4.23), même avant que le Node réponde, le panneau SHALL afficher qui invite et l'équipe, comme texte, puis attendre « Rejoindre » ou « Refuser ». Il MUST NOT envoyer de demande d'appairage avant « Rejoindre ». Le code MUST rester hors de l'URL une fois le panneau ouvert. Mon espace SHALL accepter le code ou le lien collé, avec le même aperçu.

#### Scenario: AC: aucun appairage sans clic
<!-- openspec-guard:test="menu bar panel and its admin routes (T4.14) > previews an invitation without pairing and pairs only after Rejoindre" -->
- **WHEN** le panneau est ouvert avec une invitation valide
- **THEN** la prévisualisation montre l'inviteur sans appairer, et l'appairage n'a lieu qu'après « Rejoindre »

#### Scenario: AC: lien drop://join
<!-- openspec-guard:test="desktop join link (T4.23) > opens drop://join like drop://pair: the confirmation card, queued until the node answers" -->
- **WHEN** la page pour rejoindre ouvre `drop://join?invite=<code>`, avant ou après le démarrage du Node
- **THEN** l'app passe le seul code base64url au panneau, comme pour `drop://pair`, et ignore un lien trop long, sans code ou d'une autre sorte

### Requirement: Carte et relecture conformes dans le panneau
Le panneau SHALL afficher sur la carte de consentement la ligne de sensibilité haute quand elle s'applique, le compte à rebours « Expire dans » et faire de « Pas maintenant » le bouton par défaut au clavier. Pour une capacité sensible, son écran de relecture SHALL proposer une case par champ de premier niveau pour le retirer avant l'envoi.

#### Scenario: AC: carte et relecture du panneau
<!-- openspec-guard:test="menu bar panel and its admin routes (T4.14) > renders expiry, high sensitivity, a default Pas maintenant and per-field redaction" -->
- **WHEN** le panneau rend une carte de capacité sensible puis son écran de relecture
- **THEN** la carte montre la sensibilité haute, « Expire dans » et « Pas maintenant » par défaut, et la relecture propose une case par champ qui ajoute ce champ aux retraits envoyés

### Requirement: Répondre moi-même dans le panneau
La carte de décision SHALL offrir « Répondre moi-même », qui ouvre une zone de texte et le choix d'un fichier texte, sans masquer ce que le demandeur recevra ou ne recevra jamais. Un brouillon MUST survivre aux rafraîchissements, et un refus MUST s'afficher avec son code traduit. Un fichier qui n'est pas en UTF-8 MUST être refusé.

#### Scenario: AC: réponse relue avant envoi
<!-- openspec-guard:test="menu bar panel (T4.3) > offers to answer by hand, keeps the ledger visible and reviews the answer before sending" -->
- **WHEN** le propriétaire choisit « Répondre moi-même », écrit puis relit sa réponse
- **THEN** le registre reste visible, la relecture montre le texte et le contenu du fichier qui partiront, et seul « Envoyer » appelle `POST /ui/answer`

### Requirement: Relecture fidèle de la réponse humaine
Avant l'envoi, le panneau MUST montrer exactement ce qui partira, contenu du fichier compris, et nommer le premier destinataire réel d'après les pairs locaux quand la capacité vit sur un autre Node.

#### Scenario: AC: destinataire réel nommé
<!-- openspec-guard:test="menu bar panel (T4.3) > offers to answer by hand, keeps the ledger visible and reviews the answer before sending" -->
- **WHEN** la capacité vit sur le Node d'un autre pair
- **THEN** la relecture dit que la réponse part chez ce pair, nommé d'après les pairs locaux, pour le demandeur

### Requirement: Ce que je publie
L'onglet « Mes outils » SHALL montrer « Ce que je publie » : sujet, énoncé, source, fin de validité, public et nombre de fois servi, avec ajouter, modifier et retirer. Un fait expiré ou retiré MUST apparaître en grisé avec son état. Le texte des faits MUST être inséré comme texte.

#### Scenario: AC: liste des faits publiés
<!-- openspec-guard:test="menu bar panel (T4.4) > lists what I publish with add, edit and retire, and greys out an expired fact" -->
- **WHEN** le propriétaire ouvre « Mes outils »
- **THEN** il voit ses faits, peut en ajouter, modifier et retirer, et un fait expiré est grisé

### Requirement: Analyse des treize clients dans le panneau
« Connecter mes agents » SHALL analyser les treize clients, séparer configuration globale et projets, proposer d'ajouter ou de retirer un dossier de projet, et proposer de raccorder chaque client installé. L'extrait à coller et sa marche à suivre MUST n'apparaître qu'en secours, avec la raison, quand drop ne peut pas écrire. Les textes « quatre agents » et « à copier » pour un client automatique MUST disparaître.

#### Scenario: AC: analyse et projets dans le panneau
<!-- openspec-guard:test="menu bar panel (T4.5) > analyses thirteen clients, separates global and project configurations, and shows manual steps" -->
- **WHEN** le propriétaire analyse son ordinateur
- **THEN** il voit les treize clients, une section projets avec ajout et retrait de dossier, et l'extrait de secours d'un client que drop ne peut pas écrire

#### Scenario: AC: aucun copier-coller pour un client automatique
<!-- openspec-guard:test="menu bar panel (T4.22) > connects every client without a copy step and explains the fallback only when a write is impossible" -->
- **WHEN** le panneau affiche l'analyse sur macOS, Windows ou Linux
- **THEN** aucun client n'est marqué « raccordement à la main », le bouton dit « Analyser cet ordinateur », et chaque cause de secours (fichier verrouillé, emplacement non documenté, commande non sûre, fichier illisible) a son explication

### Requirement: Choix du relais Internet
« Mes outils » SHALL proposer « Connexion par Internet » : désactivée (par défaut), direct seulement, mon relais ou celui de l'équipe (adresse), ou relais de test de n0 signalé comme tiers qui voit les adresses IP. L'état MUST dire si le programme est prêt et expliquer un échec.

#### Scenario: AC: choix du relais
<!-- openspec-guard:test="internet (T4.2b) > lets the owner choose no relay, their own relay or the n0 test relays, flagged as third party" -->
- **WHEN** le propriétaire choisit son relais, puis les relais de test de n0
- **THEN** la configuration garde son choix, et le panneau signale n0 comme un tiers de test qui voit les adresses IP

### Requirement: Mises à jour signées
Une app construite avec la clé de mise à jour SHALL chercher une version au lancement puis toutes les 6 h sur `https://drop.memolabs.dev/updates/latest.json` et la proposer dans le menu ; rien ne s'installe sans ce clic (D70). L'archive MUST être signée par cette clé pour la version annoncée (`requireSignedVersion`), sinon refusée. Sans la clé, l'app ne cherche aucune mise à jour (D76). La construction MUST refuser un manifeste signé pour une autre version.

#### Scenario: Manifeste publié
<!-- openspec-guard:test="signed updates of the Mac app (T2.4) > announces the build for darwin-aarch64 with its signature and a versioned URL under /updates" -->
- **WHEN** la version x.y.z est construite avec `--updates`
- **THEN** `latest.json` annonce x.y.z pour `darwin-aarch64`, avec la signature de l'archive et son URL sous `/updates/`

#### Scenario: Signature d'une autre version
<!-- openspec-guard:test="signed updates of the Mac app (T2.4) > refuses a signature made for another version, or carrying none" -->
- **WHEN** la signature de l'archive porte une autre version, ou aucune
- **THEN** la construction du manifeste échoue avec `E_UPDATE_SIGNATURE`

#### Scenario: Clé publique et HTTPS
<!-- openspec-guard:test="signed updates of the Mac app (T2.4) > turns the updater on only with a public key, over HTTPS, and requires the version in the signature" -->
- **WHEN** l'app est construite avec `--updates`
- **THEN** sa configuration porte la clé publique, l'adresse HTTPS de `latest.json` et `requireSignedVersion`, et une clé vide ou un chemin de fichier est refusé avec `E_UPDATER_KEY`

#### Scenario: Mise à jour proposée, pas imposée
<!-- openspec-guard:non-testable reason="App native : à vérifier à la main à la première version publiée sur drop.memolabs.dev/updates" -->
- **WHEN** une version plus récente est publiée
- **THEN** le menu de l'icône affiche « Mettre à jour vers x.y.z », et seul un clic télécharge, vérifie la signature, installe et relance l'app avec son Node

### Requirement: Connexion proposée dans le panneau
Quand le partage d'un outil échoue avec `E_SHARE_OAUTH`, le panneau SHALL proposer « Se connecter à <serveur> », qui
démarre la connexion de drop (T2.17). Le lien de secours vers la page de connexion MUST n'être affiché que s'il est en
https.

#### Scenario: Outil qui demande une connexion
<!-- openspec-guard:test="menu bar panel and its admin routes (T2.4) > offers to sign in when a shared server needs OAuth, and links only an https sign-in page (T2.17)" -->
- **WHEN** Natha partage Notion avant d'y avoir connecté drop
- **THEN** le panneau propose « Se connecter à notion », et n'affiche la page de connexion qu'en https

### Requirement: Panneau accessible
Le panneau SHALL exposer ses onglets en `tablist`, `tab` et `tabpanel`, que les flèches, Début et Fin parcourent. Il SHALL annoncer chaque résultat d'action dans une région vivante et y déplacer le focus, et annoncer l'état de connexion dans sa propre région polie. Un échec de chargement MUST s'afficher en alerte avec « Réessayer ». Le panneau SHALL suivre les réglages du système : thème clair ou sombre, « réduire les animations », « réduire la transparence » et « augmenter le contraste ».

#### Scenario: AC: onglets au clavier
<!-- openspec-guard:test="menu bar panel (T4.24) > uses tabs with arrow keys, Home and End, and a badge counting what waits" -->
- **WHEN** le focus est sur « Demandes » et que l'utilisateur presse Flèche droite, puis Fin, puis Début
- **THEN** l'onglet suivant, le dernier puis le premier prennent le focus et s'affichent, et le badge de « Demandes » dit combien de décisions attendent

#### Scenario: AC: résultat annoncé et focalisé
<!-- openspec-guard:test="menu bar panel (T4.24) > announces each result, moves the focus to it, and shows the connection state in its own live region" -->
- **WHEN** le propriétaire autorise une demande
- **THEN** le bandeau « Demande autorisée une fois. » reçoit le focus et la région vivante l'annonce, pendant que l'état de connexion garde sa propre région

#### Scenario: AC: échec de chargement
<!-- openspec-guard:test="menu bar panel (T4.24) > shows a load failure as an alert with Réessayer, and a refusal with its translated code" -->
- **WHEN** le Node ne répond pas à la lecture d'un onglet
- **THEN** une alerte « Impossible de charger cette section » s'affiche avec « Réessayer », qui relit l'onglet

#### Scenario: AC: réglages d'affichage du système
<!-- openspec-guard:test="menu bar panel (T4.24) > honours reduced motion, reduced transparency, increased contrast and both themes in its stylesheet" -->
- **WHEN** le système demande le thème sombre, moins d'animations, moins de transparence ou plus de contraste
- **THEN** la feuille de style du panneau applique chaque réglage, et le focus garde un contour visible de 2 px en couleur d'accent

### Requirement: Inviter par le lien unique dans le panneau
« Inviter quelqu’un dans l’équipe » SHALL afficher et copier le lien https de `POST /ui/invite` (`link`, `https://drop.memolabs.dev/join#<invitation>`), qui fonctionne sans que l'invité ait déjà drop, et dire qu'il vaut 24 h, une fois, pour une seule personne. Le panneau MUST NOT donner de lien `drop://pair` à envoyer (T4.31).

#### Scenario: AC: lien https à envoyer
<!-- openspec-guard:test="menu bar panel (T4.31) > gives the https join link to send, never drop://pair" -->
- **WHEN** le propriétaire clique sur « Inviter quelqu’un dans l’équipe » puis « Copier le lien »
- **THEN** le panneau affiche le lien https renvoyé par le Node et copie exactement ce lien, sans aucun `drop://pair`

### Requirement: Connecter mes agents après Rejoindre
Quand « Rejoindre » réussit et que le Node répond `next: 'connect_agents'`, le panneau SHALL proposer « Connecter mes agents » et « Plus tard ». « Connecter mes agents » SHALL ouvrir « Mes outils » et lancer l'analyse locale ; le raccordement MUST rester une seconde action explicite. Quand le poste vient d'adopter le relais de l'invitation (`relay: 'adopt'`), la proposition SHALL nommer ce relais, comme texte (T4.31).

#### Scenario: AC: étape suivante après Rejoindre
<!-- openspec-guard:test="menu bar panel (T4.31) > offers Connecter mes agents after Rejoindre, then analyses this computer on one click" -->
- **WHEN** l'invitée clique sur « Rejoindre », puis sur « Connecter mes agents »
- **THEN** le panneau annonce le relais adopté, ouvre « Mes outils », analyse l'ordinateur sans rien raccorder, et seul « Connecter les agents sélectionnés » écrit une configuration ; « Plus tard » ferme la proposition sans analyse

### Requirement: Lien drop:// vers l'app déjà ouverte sous Windows et Linux
Sous Windows et Linux, la coque SHALL enregistrer en premier le plugin `single-instance` avec `deep-link` : un second processus passe son lien `drop://` à l'instance ouverte, puis s'arrête sans daemon. Lancée depuis une AppImage, la coque SHALL enregistrer le schéma `drop` à chaque lancement ; un échec MUST être journalisé (`E_DEEP_LINK`) sans bloquer le lancement (T4.31).

#### Scenario: AC: instance unique et AppImage
<!-- openspec-guard:test="desktop single instance (T4.31) > hands a drop:// link to the running app on Windows and Linux, and registers the scheme from an AppImage" -->
- **WHEN** on lit la coque, sa configuration et ses dépendances
- **THEN** `single-instance` avec `deep-link` est le premier plugin sous Windows et Linux, les liens reçus passent par le même `open_links` que le premier lancement, et une AppImage appelle `register_all` en journalisant `E_DEEP_LINK` sur échec

#### Scenario: Lien ouvert pendant que l'app tourne
<!-- openspec-guard:non-testable reason="Comportement du système : à vérifier à la main sous Windows 10 et 11 et sous Ubuntu (AppImage et .deb), au banc maison T4.6c" -->
- **WHEN** drop tourne sous Windows ou Linux et que la page `/join` ouvre `drop://join?invite=<code>`
- **THEN** l'instance ouverte montre la carte de confirmation, aucun second daemon ni seconde icône n'apparaît
