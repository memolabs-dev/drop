## ADDED Requirements

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
