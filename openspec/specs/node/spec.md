# node Specification

## Purpose
Package `packages/node`, binaire `drop` : un daemon long (`drop serve`) et des sous-commandes qui portent l'identité, la configuration locale, l'appairage, l'API locale utilisée par `requester-mcp` et les surfaces de consentement de l'approbateur.

## Requirements

### Requirement: Répertoire DROP_HOME
L'état local d'un Node SHALL vivre dans `DROP_HOME`, qui vaut `~/.drop` par défaut.

#### Scenario: Valeur par défaut
- **WHEN** `drop` s'exécute sans variable `DROP_HOME`
- **THEN** il lit et écrit son état dans `~/.drop`

### Requirement: Contenu de DROP_HOME
`DROP_HOME` SHALL contenir `identity.json` (clés, mode `0600`), `peers.json` (Nodes connus et leurs noms), `capabilities/` (cartes publiées par ce Node), `receipts/` (JSONL) et `config.json` (URL du relais, rôle).

#### Scenario: Arborescence après init
- **WHEN** un Node est initialisé puis appairé, a publié une capacité et a traité un Drop
- **THEN** `DROP_HOME` contient `identity.json`, `peers.json`, `capabilities/`, `receipts/` et `config.json`

### Requirement: Clés privées en mode 0600
`identity.json`, qui contient les clés du Node, MUST avoir le mode fichier `0600`.

#### Scenario: Permissions de l'identité
- **WHEN** `drop init` crée `identity.json`
- **THEN** le mode du fichier est `0600`

### Requirement: Reçus en JSONL
Le Node SHALL écrire ses reçus en JSONL dans `DROP_HOME/receipts/`.

#### Scenario: Reçu écrit
- **WHEN** un Drop auquel ce Node participe produit un `receipt`
- **THEN** une ligne JSON est ajoutée dans un fichier de `DROP_HOME/receipts/`

### Requirement: Plusieurs Nodes sur une même machine
Plusieurs Nodes sur une même machine SHALL fonctionner avec plusieurs `DROP_HOME` distincts ; c'est ainsi qu'on simule un second propriétaire (« Julie ») en dev.

#### Scenario: Deux Nodes locaux
- **WHEN** on lance deux `drop serve` avec deux `DROP_HOME` différents
- **THEN** chacun a sa propre identité, ses pairs et ses reçus, sans partage d'état

### Requirement: Commande drop init
`drop init --name "Guillaume" --kind human --relay wss://…` SHALL créer `DROP_HOME`, l'identité et la configuration.

#### Scenario: Initialisation
- **WHEN** on lance `drop init --name "Guillaume" --kind human --relay wss://relay.example/v1` sur un `DROP_HOME` vide
- **THEN** `DROP_HOME`, `identity.json` et `config.json` (URL du relais, rôle) sont créés

### Requirement: Commandes drop invite et drop pair
`drop invite` et `drop pair <code>` SHALL réaliser l'appairage tel que défini par le protocole (code d'invitation, `pair_request`, `pair_accept`, `peers.json`). `drop invite --link` SHALL afficher le lien à envoyer (T4.23) ; `drop join <code-ou-lien>` SHALL rejoindre l'équipe de l'inviteur et accepter le code comme le lien, `drop pair` restant un synonyme.

#### Scenario: Appairage par la CLI
- **WHEN** A lance `drop invite` et B lance `drop pair <code>` avec le code obtenu
- **THEN** A et B se trouvent chacun dans le `peers.json` de l'autre

#### Scenario: Nouveau venu appairé sans modifier le relais
<!-- openspec-guard:test="joining the relay by invitation (T2.1) > a node the relay does not know pairs through an invite code and is admitted, with no allowlist edit" -->
- **WHEN** B, inconnu du relais, lance `drop pair <code>` avec un code de A
- **THEN** B garde le ticket d'admission du code, se reconnecte aussitôt avec, est admis, et A et B sont appairés
- **AND** le ticket est effacé du disque de B une fois admis

### Requirement: Qui paie le modèle
La config du Node SHALL porter `payer: 'requester' | 'owner'` pour ce qu'il exécute : défaut `requester` (D27) en profil `legacy`, `owner` en profil privé, où `requester` MUST être refusé par le schéma (D40). Un exécuteur en `payer: 'owner'` ignore la clé reçue et paie avec sa propre config.

#### Scenario: Le propriétaire paie
<!-- openspec-guard:test="the requester pays with a capped key (T2.3, D27) > an owner who pays ignores the key and the card says the cost is theirs" -->
- **WHEN** l'exécuteur est en `payer: 'owner'` et reçoit une demande avec une clé
- **THEN** la capacité tourne sans la clé et la carte indique `paidBy: 'owner'`

#### Scenario: AC: le propriétaire paie en profil privé
<!-- openspec-guard:test="configuration hygiene (T4.15) > makes the owner pay in the private profile and refuses a requester payer" -->
- **WHEN** une config privée omet `payer`, ou porte `payer: 'requester'`
- **THEN** la première est lue avec `payer: 'owner'` et la seconde est refusée

### Requirement: Clé plafonnée du demandeur
La config MAY porter `funding: { kind: 'openrouter', managementKeyEnv, perDropUsd, model? }`. Le Node demandeur SHALL
alors créer par demande une clé OpenRouter plafonnée à `perDropUsd`, qui expire au bout de 2 h, et la supprimer quand la
demande se termine. Sans clé de gestion, ou si l'API refuse, il n'envoie pas de clé.

#### Scenario: Clé plafonnée créée puis supprimée
<!-- openspec-guard:test="OpenRouter capped keys > mints a key capped and expiring, then deletes it by hash" -->
- **WHEN** le demandeur envoie une demande avec `funding` configuré
- **THEN** il crée une clé `POST /keys` avec `limit` = `perDropUsd` et `expires_at` à 2 h, puis la supprime par `DELETE /keys/{hash}`

#### Scenario: Pas de clé de gestion
<!-- openspec-guard:test="OpenRouter capped keys > sends no key when the management key is missing or the API refuses" -->
- **WHEN** la variable de la clé de gestion est absente ou l'API refuse
- **THEN** la demande part sans clé et l'erreur est journalisée avec un code stable

### Requirement: Détection des agents et de leurs serveurs MCP
`drop detect` SHALL lister, en moins de 3 secondes, les agents de code présents (Claude Code, Claude Desktop, Cursor,
Codex), si drop y est installé, et leurs serveurs MCP lus dans leurs fichiers de config, avec le genre de chaque
serveur quand son nom, sa commande ou son URL le dit (Figma, Notion, GitHub, Linear, Jira, base de données, CRM…). La
sortie MUST NOT contenir de valeur secrète : seulement les noms de variables et d'en-têtes (T2.8, D28).

#### Scenario: Inventaire sans secret
<!-- openspec-guard:test="detecting agents and their MCP servers (T2.8) > lists each agent, whether drop is installed, and what each server is, without any secret value" -->
- **WHEN** Claude Code déclare un serveur Notion avec `NOTION_TOKEN` et le serveur drop, et Cursor un CRM
- **THEN** `drop detect` montre Notion (genre `notion`, variable `NOTION_TOKEN`), drop installé dans Claude Code, le CRM
  dans Cursor, et aucune valeur de jeton

### Requirement: Partage d'un serveur détecté
`drop share <agent>/<serveur>` SHALL publier `mcp.answer.<genre ou nom>` sur ce serveur, tel que l'agent le déclare,
avec par défaut les seuls outils que le serveur marque `readOnlyHint` ; si aucun ne l'est, la commande MUST demander
`--tools`. Les serveurs de drop lui-même ne sont jamais proposés.

#### Scenario: Partage en une commande
<!-- openspec-guard:test="detecting agents and their MCP servers (T2.8) > drop share publishes a detected server with its read-only tools, and never drop itself" -->
- **WHEN** Julie lance `drop share claude_code/figma`
- **THEN** `mcp.answer.figma` est publié avec le libellé « mon Figma », le serveur désigné par l'agent et les seuls outils en lecture seule
- **AND** `drop share` sur le serveur de drop lui-même est refusé

### Requirement: Équipe
Un Node SHALL pouvoir créer une équipe (`drop team create <nom>`) ; ses invitations portent alors l'équipe, et qui
s'appaire avec elles la rejoint (T2.9, D28). Chaque membre MUST envoyer la liste des membres (`team_roster`) à un
nouveau pair de l'équipe, et à tous les membres quand sa liste change. Un membre inconnu reçu d'un membre de la même
équipe MUST devenir un pair, présenté par ce membre (`via`), et recevoir une demande de catalogue.

#### Scenario: Tout le monde se connaît
<!-- openspec-guard:test="team (T2.9) > everyone invited by any member ends up paired with every member, and sees their agents and tools" -->
- **WHEN** Guillaume crée l'équipe Atlas et invite Julie, Julie invite Natha, et Guillaume invite Sami
- **THEN** chacun des quatre a les trois autres pour pairs et dans son équipe, sans autre appairage
- **AND** `drop team` montre chaque membre avec ses agents, en ligne ou non, et ce qu'il partage

### Requirement: Liste d'une autre équipe ignorée
Un Node MUST ignorer une liste `team_roster` d'une autre équipe, ou reçue alors qu'il n'est dans aucune équipe ;
aucune liste ne choisit un outil ni n'autorise une demande : chaque demande passe toujours par le consentement.

#### Scenario: Liste étrangère
<!-- openspec-guard:test="team (T2.9) > ignores a roster from another team, and a node outside any team ignores rosters" -->
- **WHEN** un pair qui n'est pas de l'équipe envoie une liste d'une autre équipe avec un inconnu
- **THEN** ni la liste des membres ni les pairs ne changent

### Requirement: Routage d'une question
`POST /ask { question, purpose?, agent }` SHALL choisir au plus trois capacités qui prennent une question libre, par des
règles sans modèle (D32) : un prénom cité dans la question l'emporte ; sinon les mots de la question sont comparés au
genre de chaque outil partagé (Figma, code, GitHub, Notion, Linear, Jira, CRM, base de données…). Le Node MUST envoyer
une demande à chacune et MUST n'en envoyer aucune quand rien ne correspond.

#### Scenario: Mots de la question
<!-- openspec-guard:test="routing a plain question to the right people (T2.12, D32) > matches the words of the question to the kind of each shared tool" -->
- **WHEN** la question parle de la couleur d'un bouton sur la maquette, ou des PR, des tickets et du contrat client
- **THEN** elle part vers Figma, ou vers GitHub, Linear et le CRM

#### Scenario: Prénom ou rien
<!-- openspec-guard:test="routing a plain question to the right people (T2.12, D32) > a first name wins, accents and case do not matter, and nothing is sent when nothing matches" -->
- **WHEN** la question cite « sami », ou ne correspond à aucun outil
- **THEN** elle part vers l'outil de Sami, ou nulle part

#### Scenario: Question libre seulement
<!-- openspec-guard:test="routing a plain question to the right people (T2.12, D32) > only capabilities that take a free-text question can be asked" -->
- **WHEN** une capacité demande des champs précis (`service`, `window`)
- **THEN** le routage ne la choisit jamais

### Requirement: Commande drop peers
`drop peers` SHALL lister les pairs.

#### Scenario: Liste des pairs
- **WHEN** on lance `drop peers` sur un Node appairé
- **THEN** chaque pair de `peers.json` est affiché

### Requirement: Daemon drop serve
`drop serve` SHALL être un process long qui maintient la connexion au relais, sert l'API locale et l'UI locale, et lance le runner si des capacités sont publiées sur ce Node.

#### Scenario: Runner conditionnel
- **WHEN** `drop serve` démarre sur un Node sans capacité publiée
- **THEN** l'API locale et l'UI locale sont servies, sans runner

#### Scenario: Runner actif
- **WHEN** `drop serve` démarre sur un Node qui a publié une capacité
- **THEN** le runner est lancé en plus de l'API et de l'UI locales

### Requirement: Reconnexion exponentielle au relais
`drop serve` MUST se reconnecter seul au relais après une coupure, avec un délai exponentiel de 1 s à 30 s. Une connexion morte ou à moitié ouverte, détectée par le client relais (spec `relay`, « Battement de cœur du client relais » et les exigences du client relais qui la suivent), MUST compter comme une coupure. Une enveloppe restée sans acquittement MUST revenir dans la file d'envoi et repartir à la reconnexion.

#### Scenario: AC: drop serve se reconnecte seul après coupure du relais
- **WHEN** le relais coupe la connexion puis redevient disponible
- **THEN** `drop serve` se reconnecte sans intervention

#### Scenario: Délais bornés
- **WHEN** le relais reste indisponible
- **THEN** les délais entre tentatives croissent exponentiellement depuis 1 s sans dépasser 30 s

#### Scenario: AC: envoi repris après une connexion à moitié ouverte
<!-- openspec-guard:test="relay liveness (T3.1f) > sends a pairing request again after the relay connection went half-open, and the pairing completes" -->
- **WHEN** la connexion au relais cesse de transmettre sans se fermer pendant qu'une demande d'appairage part
- **THEN** l'envoi revient dans la file, le Node se reconnecte, la demande repart et l'appairage aboutit

### Requirement: Commande drop publish
`drop publish <capability-id> [--approver <nodeId>]` SHALL publier sur ce Node une capacité du package `capabilities`, avec l'approbateur indiqué.

#### Scenario: Publication avec approbateur distant
- **WHEN** on lance `drop publish production.error_summary --approver <nodeId du Mac>` sur le Node VPS
- **THEN** la carte est enregistrée dans `DROP_HOME/capabilities/` avec ce `nodeId` parmi `approverNodeIds`

### Requirement: Commande drop pending
`drop pending` SHALL lister les demandes en attente d'approbation, en alternative CLI à l'UI.

#### Scenario: Demandes en attente
- **WHEN** un `approval_request` non décidé est en file et on lance `drop pending`
- **THEN** la demande est listée avec son `dropId`

### Requirement: Décision en CLI
`drop approve <dropId>`, `drop deny <dropId>` et `drop not-now <dropId>` SHALL émettre respectivement les décisions `allow_once`, `deny` et `not_now` pour ce Drop.

#### Scenario: Approbation en CLI
- **WHEN** on lance `drop approve <dropId>` sur une demande en attente
- **THEN** l'exécuteur reçoit une décision `allow_once` pour ce `dropId`

### Requirement: Commande drop receipts
`drop receipts [--since 7d]` SHALL afficher l'historique des reçus, filtré sur la période donnée par `--since`.

#### Scenario: Historique filtré
- **WHEN** on lance `drop receipts --since 7d`
- **THEN** seuls les reçus des 7 derniers jours sont affichés

### Requirement: Écoute de l'API locale
L'API locale SHALL être servie en HTTP sur `127.0.0.1:<port>` uniquement, port 7781 par défaut ; elle est l'interface utilisée par `requester-mcp`.

#### Scenario: Adresse d'écoute
- **WHEN** `drop serve` démarre sans port configuré
- **THEN** l'API locale écoute sur `127.0.0.1:7781` et sur aucune autre interface

### Requirement: Jeton de l'API locale
L'API locale MUST exiger un jeton aléatoire non vide, écrit dans `DROP_HOME/local-token` en mode `0600` et présenté dans l'en-tête `Authorization: Bearer`, ou dans `?token=` pour l'UI et son flux SSE. Toute requête sans jeton valide MUST être refusée. `drop serve` MUST refuser de démarrer l'API locale si ce fichier est absent, vide ou réduit à des espaces ; il MUST signaler une erreur stable sans journaliser le jeton.

#### Scenario: AC: requête sans jeton refusée
<!-- openspec-guard:test="refuses a request without the token" -->
- **WHEN** une requête arrive sur l'API locale sans en-tête `Authorization: Bearer <jeton>` valide
- **THEN** elle est refusée (test)

#### Scenario: Fichier du jeton
<!-- openspec-guard:test="creates a local token with owner-only permissions" -->
- **WHEN** `drop serve` crée le jeton
- **THEN** `DROP_HOME/local-token` existe en mode `0600`

#### Scenario: AC: jeton local absent ou vide au démarrage
<!-- openspec-guard:test="refuses to start with a missing or empty local token" -->
- **WHEN** `drop serve` trouve `DROP_HOME/local-token` absent, vide ou composé uniquement d'espaces
- **THEN** il échoue avec `E_TOKEN` avant de lancer le relais ou d'ouvrir l'API locale, sans imprimer le contenu du fichier

#### Scenario: AC: présentation vide refusée
<!-- openspec-guard:test="rejects missing and empty presented tokens" -->
- **WHEN** un client appelle l'API, l'UI ou le flux SSE sans jeton, avec un `Bearer` vide ou avec `?token=` vide
- **THEN** la requête est refusée, même si la configuration du serveur est invalide ou vide

#### Scenario: AC: jeton valide préservé
<!-- openspec-guard:test="preserves authenticated local API and panel access" -->
- **WHEN** `drop serve` possède un jeton non vide et le client présente cette valeur
- **THEN** l'API et le panneau local restent accessibles selon leurs règles existantes

### Requirement: Contrôle de l'en-tête Host
L'API locale MUST refuser toute requête dont l'en-tête `Host` n'est pas `127.0.0.1:<port>` ou `localhost:<port>`, pour se protéger du DNS rebinding.

#### Scenario: AC: Host étranger refusé
- **WHEN** une requête avec un jeton valide porte `Host: evil.example:7781`
- **THEN** elle est refusée (test)

#### Scenario: Host local accepté
- **WHEN** une requête avec un jeton valide porte `Host: localhost:7781`
- **THEN** elle est traitée

### Requirement: Route GET /peers
`GET /peers` SHALL renvoyer les pairs et leur statut de connexion.

#### Scenario: Pairs et statut
- **WHEN** `requester-mcp` appelle `GET /peers`
- **THEN** la réponse liste chaque pair avec son statut de connexion

### Requirement: Route GET /capabilities
`GET /capabilities` SHALL renvoyer le catalogue agrégé des pairs, mis en cache 60 s et rafraîchi par `catalog_request`.

#### Scenario: Cache du catalogue
- **WHEN** `GET /capabilities` est appelé deux fois en moins de 60 s
- **THEN** aucun nouveau `catalog_request` n'est envoyé pour le second appel

#### Scenario: Rafraîchissement
- **WHEN** le cache a plus de 60 s
- **THEN** le Node envoie `catalog_request` aux pairs pour rafraîchir le catalogue

### Requirement: Route POST /drops
`POST /drops` SHALL accepter `{ capabilityId, input, purpose, agent }` et renvoyer `{ dropId }`.

#### Scenario: Création d'un Drop
- **WHEN** `requester-mcp` envoie `POST /drops` avec `{ capabilityId, input, purpose, agent }`
- **THEN** la réponse est `{ dropId }`

### Requirement: Route GET /drops/:id
`GET /drops/:id` SHALL renvoyer l'état courant du Drop, avec son résultat ou son erreur.

#### Scenario: Polling du résultat
- **WHEN** l'agent interroge `GET /drops/:id` après réception d'un `drop_result`
- **THEN** la réponse contient l'état et le résultat

#### Scenario: Erreur
- **WHEN** le Drop a reçu un `drop_error`
- **THEN** `GET /drops/:id` renvoie l'état et l'erreur

### Requirement: Séquence nominale côté Node demandeur
Sur `POST /drops`, le Node demandeur SHALL envoyer via le relais une enveloppe `drop_request` chiffrée pour le Node exécuteur.

#### Scenario: Requête transmise
- **WHEN** `requester-mcp` appelle `POST /drops` sur le Node Mac pour une capacité du Node VPS
- **THEN** une enveloppe `drop_request` chiffrée pour le Node VPS part vers le relais

### Requirement: Séquence nominale validation par l'exécuteur
À réception d'un `drop_request`, le Node exécuteur MUST le valider (schéma, signature, expiration, quota) avant d'envoyer `approval_request` à l'approbateur.

#### Scenario: Requête valide
- **WHEN** le Node VPS reçoit un `drop_request` valide
- **THEN** il envoie un `approval_request` au Node approbateur (le Mac)

#### Scenario: Requête invalide
- **WHEN** le `drop_request` échoue à la validation
- **THEN** aucun `approval_request` n'est envoyé

### Requirement: Séquence nominale affichage chez l'approbateur
À réception d'un `approval_request`, le Node approbateur SHALL afficher la carte de consentement dans l'UI locale et par notification.

#### Scenario: Demande affichée
- **WHEN** le Node Mac reçoit un `approval_request`
- **THEN** la carte apparaît dans l'UI locale et une notification est émise

### Requirement: Séquence nominale décision signée
Quand l'approbateur clique « Autoriser une fois » (`Allow once`), son Node SHALL envoyer une décision signée au Node exécuteur, dont le runner exécute ensuite la capacité. La séquence nomme ce message `drop_decision` ; la table du protocole le nomme `approval_decision`.

#### Scenario: Autorisation puis exécution
- **WHEN** l'approbateur clique « Autoriser une fois »
- **THEN** le Node exécuteur reçoit une décision signée `allow_once` et le runner exécute la capacité

### Requirement: Séquence nominale relecture en sensibilité haute
Après validation par le schéma et scan de la sortie, le Node exécuteur SHALL renvoyer la sortie à l'approbateur pour relecture si la capacité est `high`.

#### Scenario: Sortie à relire
- **WHEN** une capacité `high` produit une sortie validée et scannée
- **THEN** le Node exécuteur envoie un `review_request` à l'approbateur avant tout `drop_result`

### Requirement: Séquence nominale livraison et reçus
Le Node exécuteur SHALL envoyer `drop_result` au demandeur, et les deux côtés MUST écrire un `receipt`.

#### Scenario: Livraison
- **WHEN** un Drop est livré
- **THEN** le demandeur reçoit `drop_result`, et le Node exécuteur comme le Node demandeur ont un reçu écrit

### Requirement: Deux surfaces de consentement, une file
Le consentement SHALL être offert par deux surfaces, l'UI web locale et la notification, qui partagent la même file d'attente.

#### Scenario: Décision depuis une surface
- **WHEN** une demande est décidée depuis l'UI locale
- **THEN** elle disparaît aussi de `drop pending`

### Requirement: UI web locale
`drop serve` SHALL servir sur `127.0.0.1` une page unique, sans framework, qui liste les demandes en attente et se rafraîchit par SSE. Elle MUST exiger le même jeton que l'API, transmis par un lien ouvert localement.

#### Scenario: Nouvelle demande poussée
- **WHEN** une nouvelle demande arrive pendant que la page est ouverte
- **THEN** elle apparaît sans rechargement, via SSE

#### Scenario: Accès sans jeton
- **WHEN** on ouvre l'UI locale sans le jeton
- **THEN** l'accès est refusé

### Requirement: Notification macOS
Sur macOS, le Node SHALL notifier chaque demande avec le titre « {Nom} a besoin d'aide » et pour sous-titre le titre de la capacité ; un clic SHALL ouvrir l'UI locale. Lancé par l'app Mac (`DROP_NOTIFY=shell`), il MUST remettre la notification à l'app, qui l'affiche avec son icône ; ailleurs, il utilise `osascript`. `DROP_NOTIFY=off`, réservé au banc de simulation, MUST l'empêcher.

#### Scenario: Notification émise
- **WHEN** une demande de Julie pour « Résumer les erreurs de production » arrive sur macOS
- **THEN** une notification « Julie a besoin d'aide » s'affiche avec ce sous-titre, et un clic ouvre l'UI locale

#### Scenario: AC: banc de simulation silencieux
<!-- openspec-guard:test="notifications (T4.1) > AC stays silent when DROP_NOTIFY is off, even on macOS" -->
- **WHEN** le Node tourne sur macOS avec `DROP_NOTIFY=off`
- **THEN** aucune notification n'est émise

#### Scenario: AC: notification remise à l'app
<!-- openspec-guard:test="notifications (T4.14) > AC hands the notification to the Mac app as one JSON line in shell mode" -->
- **WHEN** le Node tourne avec `DROP_NOTIFY=shell` et qu'une demande arrive
- **THEN** il écrit une seule ligne JSON `dropNotify` portant titre et sous-titre, et n'appelle pas `osascript`

### Requirement: Pas de notification sous Linux
Sous Linux, le Node SHALL ne pas émettre de notification ; `drop pending` suffit.

#### Scenario: Linux
- **WHEN** une demande arrive sur un Node Linux
- **THEN** aucune notification n'est émise et la demande est visible par `drop pending`

### Requirement: Contenu exact de la carte de consentement
La carte SHALL afficher exactement ce contenu, dans cet ordre (ligne « Sensibilité haute » seulement si `high`), au tutoiement sur la page historique comme dans le panneau :

```text
{requestedBy.displayName} a besoin d'aide            via {agent}
{card.title}
« {inputPreview} »

Pourquoi : {purpose}

{displayName} recevra :            {receives[]}
{displayName} ne recevra jamais :  {neverReceives[]}
Coût max : {maxUsd} $, à ta charge.   (ou « gratuit », ou « non mesuré » ; absent si la capacité ne coûte rien)
Sensibilité haute : tu reliras le résultat avant envoi.   (si high)

Expire dans {mm:ss}

[ Pas maintenant ]   [ Refuser ]   [ Autoriser une fois ]
```

#### Scenario: Ordre des éléments
<!-- openspec-guard:test="consent UI > shows no technical identifier and defaults to « Pas maintenant »" -->
- **WHEN** la carte d'une demande est rendue
- **THEN** les éléments apparaissent dans l'ordre : demandeur et agent, titre, aperçu de l'entrée, « Pourquoi », « recevra », « ne recevra jamais », coût éventuel, sensibilité haute éventuelle, « Expire dans », puis les boutons « Pas maintenant », « Refuser », « Autoriser une fois »

#### Scenario: Ligne de sensibilité haute
<!-- openspec-guard:test="consent UI > omits the high-sensitivity line for a low capability and words it in tu otherwise" -->
- **WHEN** la capacité est `low`
- **THEN** la ligne « Sensibilité haute : tu reliras le résultat avant envoi. » est absente

### Requirement: Aucun identifiant technique sur la carte
La carte de consentement MUST NOT afficher d'identifiant technique : ni `nodeId`, ni nom d'outil, ni id de capacité.

#### Scenario: Carte sans identifiant
- **WHEN** la carte d'une demande pour `production.error_summary` est rendue
- **THEN** ni le `nodeId`, ni un nom d'outil, ni la chaîne `production.error_summary` n'y figurent

### Requirement: Aperçu d'entrée échappé
`inputPreview` MUST être un rendu lisible et échappé de l'entrée : aucun HTML n'est interprété.

#### Scenario: AC: l'UI échappe une entrée contenant script
<!-- openspec-guard:test="menu bar panel and its admin routes (T2.4) > inserts what peers wrote as text only" -->
- **WHEN** l'entrée d'une demande contient `<script>`
- **THEN** l'UI affiche le texte littéral et n'exécute ni n'interprète le HTML (test)

### Requirement: Bouton par défaut au clavier
Le bouton par défaut au clavier MUST être « Pas maintenant », jamais « Autoriser ».

#### Scenario: Entrée au clavier
<!-- openspec-guard:test="menu bar panel and its admin routes (T4.14) > renders expiry, high sensitivity, a default Pas maintenant and per-field redaction" -->
- **WHEN** l'utilisateur presse Entrée sur une carte sans avoir choisi de bouton
- **THEN** la décision émise est `not_now`

### Requirement: Expiration de la demande
Une demande non décidée MUST expirer après 10 minutes par défaut : le Drop passe à `expired` et `E_EXPIRED` est envoyé au demandeur.

#### Scenario: AC: un Drop non décidé passe à expired et le demandeur reçoit E_EXPIRED
- **WHEN** avec une horloge simulée, 10 minutes s'écoulent sans décision sur une demande
- **THEN** le Drop passe à `expired` et le demandeur reçoit `E_EXPIRED` (test)

### Requirement: Écran de relecture champ par champ
Pour `sensitivity: 'high'`, l'écran de relecture SHALL afficher la sortie champ par champ, avec une case à cocher par champ de premier niveau qui permet de le retirer (`redactions`).

#### Scenario: Retrait d'un champ
- **WHEN** l'approbateur coche un champ de premier niveau puis envoie
- **THEN** la `review_decision` porte ce champ dans `redactions`

### Requirement: Boutons de l'écran de relecture
L'écran de relecture SHALL proposer les boutons « Ne pas envoyer » et « Envoyer ».

#### Scenario: Ne pas envoyer
- **WHEN** l'approbateur clique « Ne pas envoyer »
- **THEN** la `review_decision` porte `decision: 'discard'`

#### Scenario: Envoyer
- **WHEN** l'approbateur clique « Envoyer »
- **THEN** la `review_decision` porte `decision: 'send'`

### Requirement: Texte long échappé en relecture
L'écran de relecture MUST afficher le texte long tel quel, échappé.

#### Scenario: Texte avec balises
- **WHEN** un champ de sortie contient du HTML
- **THEN** il est affiché littéralement, sans interprétation ni troncature

### Requirement: Profil privé explicite
Le Node SHALL proposer un profil privé sans compte externe, passerelle cloud, financement distant automatique, télémétrie, activation de licence ni téléchargement au démarrage. Le relais et les destinations sont choisis localement. Le relais MAY être nommé par DNS, en `wss:` seulement ; il n'entre alors jamais dans les destinations permises au modèle ou aux serveurs MCP (D95). Un relais littéral MUST être une origine listée, sauf s'il est adopté (T4.33).

#### Scenario: AC: installation et cycle sans Internet
<!-- openspec-guard:test="private system > runs two private nodes with internal MCP and model through consent failure and restart" -->
- **WHEN** deux Nodes privés utilisent leur relais et leur modèle internes, Internet bloqué
- **THEN** le consentement et la réponse fonctionnent après arrêt et relance, sans connexion externe ; la recette conserve les observations réseau.

#### Scenario: AC: relais de l'équipe par nom DNS
<!-- openspec-guard:test="private configuration > initializes without cloud accounts and rejects forbidden profile settings" -->
- **WHEN** un profil privé est créé avec `wss://drop.memolabs.dev/v1`, puis avec `ws://drop.memolabs.dev/v1`, une adresse publique littérale, des identifiants, une URL `https:` ou une requête
- **THEN** le premier est accepté avec pour seule destination le modèle local, les autres sont refusés

### Requirement: Migration privée réversible
La migration SHALL être explicite, sauvegarder la configuration en mode privé, préserver identité, jeton, pairs et publications, et proposer un retour arrière sans écraser une modification concurrente.

#### Scenario: AC: migration et restauration
<!-- openspec-guard:test="private configuration > backs up migrates and restores configuration without changing identity or publications" -->
- **WHEN** une configuration historique est migrée puis restaurée
- **THEN** les autres fichiers restent identiques et une modification concurrente empêche la restauration.

### Requirement: Demandes reçues persistantes
Le Node MUST conserver au plus 16 384 identifiants reçus, sans contenu, pendant 30 minutes, dans un journal durable portant l'horloge du stockage, pour empêcher leur rejeu après redémarrage, crash ou recul d'horloge. Il MUST refuser avant accord les UUIDv7 vieux (>30 min) ou futurs (>5 min), les doublons et les admissions dont le stockage est saturé, verrouillé, illisible, incomplet ou non durable. Un stockage T3.1b MUST être vérifié puis migré sans perdre un identifiant vivant.

#### Scenario: AC: ancien consentement après redémarrage
<!-- openspec-guard:test="private restart > rejects a previously received drop after restart before any consent can be reused" -->
- **WHEN** une demande reçue avant arrêt est présentée au Node redémarré
- **THEN** elle est refusée sans nouvelle exécution ni remise en attente d'un ancien consentement

#### Scenario: AC: demande périmée ou future
<!-- openspec-guard:test="bounded received drops > rejects stale and future identifiers before writing a marker" -->
- **WHEN** une nouvelle demande porte un UUIDv7 plus vieux que 30 minutes ou avancé de plus de 5 minutes
- **THEN** le Node la refuse avant création d'une demande d'accord

#### Scenario: AC: marqueurs bornés après redémarrage
<!-- openspec-guard:test="replay store crash points > keeps the compacted journal as the only valid one" -->
- **WHEN** des identifiants périmés occupent le journal et le Node admet une demande récente
- **THEN** ils ne comptent plus dans les plafonds et la compaction les retire, sans réutiliser un ancien accord

#### Scenario: AC: retour d'horloge
<!-- openspec-guard:test="bounded received drops > prunes old markers and rejects them after restart and clock rollback" -->
- **WHEN** l'horloge locale recule après l'admission d'une demande plus récente
- **THEN** un identifiant déjà périmé reste refusé, y compris après redémarrage

#### Scenario: AC: stockage anti-rejeu saturé
<!-- openspec-guard:test="bounded received drops > refuses another claim at the marker cap" -->
- **WHEN** 16 384 identifiants non expirés occupent le stockage
- **THEN** le Node refuse une demande supplémentaire avec `E_RATE`, sans accord ni exécution

#### Scenario: AC: état anti-rejeu corrompu
<!-- openspec-guard:test="bounded received drops > fails closed when replay clock state is corrupt" -->
- **WHEN** l'en-tête du journal, qui porte l'horloge du stockage, est corrompu
- **THEN** le Node refuse les nouvelles demandes sans consentement ni exécution

#### Scenario: AC: admission concurrente
<!-- openspec-guard:test="bounded received drops > refuses a claim while another process owns the replay lock" -->
- **WHEN** un autre processus vivant possède le verrou d'admission du même `DROP_HOME`
- **THEN** le Node refuse la nouvelle demande sans rien écrire dans le stockage

#### Scenario: AC: même identifiant sous deux casses
<!-- openspec-guard:test="bounded received drops > treats lowercase and uppercase UUIDv7 as the same claim" -->
- **WHEN** le même UUIDv7 est reçu en minuscules puis en majuscules
- **THEN** le second envoi est refusé comme doublon, sans nouvel enregistrement ni consentement

#### Scenario: AC: migration d'un stockage T3.1b
<!-- openspec-guard:test="bounded received drops > migrates a format-2 store: live ids stay refused, uppercase ones merge, expired and pre-v7 ones go" -->
- **WHEN** un stockage de format 2 tient des marqueurs vivants, dont un en majuscules, un périmé et un UUIDv4
- **THEN** la première admission les vérifie, garde les vivants refusés comme doublons, abandonne les autres, écrit la version 3 puis retire les anciens fichiers

#### Scenario: AC: anciens marqueurs nil et max
<!-- openspec-guard:test="bounded received drops > deletes legacy nil and max UUID markers instead of blocking admission" -->
- **WHEN** le stockage à migrer contient un marqueur nil ou max accepté avant T3.1b
- **THEN** le Node l'abandonne et admet la nouvelle demande récente

#### Scenario: AC: fichiers étrangers dans le stockage
<!-- openspec-guard:test="bounded received drops > ignores operating system and foreign entries in the marker directory" -->
- **WHEN** `received-drops/` à migrer contient un fichier ou dossier dont le nom n'a pas la forme d'un UUID, comme `.DS_Store`
- **THEN** le Node l'ignore sans le compter et migre les marqueurs

#### Scenario: AC: entrée de forme UUID qui n'est pas un fichier
<!-- openspec-guard:test="bounded received drops > still fails closed on a marker-shaped entry that is not a file" -->
- **WHEN** `received-drops/` à migrer contient un dossier dont le nom a la forme d'un UUID
- **THEN** le Node refuse l'admission au lieu de migrer

#### Scenario: AC: stockage T3.1b incomplet
<!-- openspec-guard:test="bounded received drops > quarantines a format-2 store that lost its clock, its markers, one live marker or its version" -->
- **WHEN** un stockage de format 2 a perdu son horloge, son dossier de marqueurs, un marqueur vivant ou sa version
- **THEN** le Node refuse avec la cause, sans migrer, et n'admet de nouveau qu'à la fin de la quarantaine, où l'identifiant perdu est refusé comme périmé

#### Scenario: AC: horloge anti-rejeu perdue
<!-- openspec-guard:test="bounded received drops > quarantines a format-2 store that lost its clock, its markers, one live marker or its version" -->
- **WHEN** le fichier d'horloge d'un stockage T3.1b manque
- **THEN** le Node refuse toute admission sans recréer une horloge initiale, jusqu'à la fin de la quarantaine

#### Scenario: AC: marqueurs anti-rejeu perdus
<!-- openspec-guard:test="replay store journal (T3.1e) > quarantines a home whose journal or version disappeared instead of starting afresh" -->
- **WHEN** le journal disparaît après une admission
- **THEN** le Node ne repart pas d'un stockage vide : il refuse pendant la quarantaine puis refuse l'ancien identifiant comme périmé

#### Scenario: AC: marqueur anti-rejeu isolé perdu
<!-- openspec-guard:test="replay store journal (T3.1e) > quarantines a journal damaged before its last record, then admits again past every id it held" -->
- **WHEN** un enregistrement du journal est endommagé alors qu'un enregistrement valide le suit
- **THEN** le Node refuse avec `corrupt journal`, reste en quarantaine même si l'horloge recule, puis admet de nouveau à sa fin et refuse comme périmés les identifiants de l'état perdu

#### Scenario: AC: version anti-rejeu perdue
<!-- openspec-guard:test="replay store journal (T3.1e) > quarantines a home whose journal or version disappeared instead of starting afresh" -->
- **WHEN** le fichier de version manque alors qu'un journal valide montre un stockage déjà utilisé
- **THEN** le Node refuse l'admission sans réinitialiser l'état anti-rejeu avant la fin de la quarantaine

#### Scenario: AC: version inconnue
<!-- openspec-guard:test="replay store journal (T3.1e) > refuses a version it does not know, such as one written by a newer node" -->
- **WHEN** `received-drops-version` porte une version que ce Node ne connaît pas
- **THEN** le Node refuse l'admission

#### Scenario: AC: verrou abandonné par ce processus
<!-- openspec-guard:test="bounded received drops > reclaims only its own replay lock and refuses an old foreign lock" -->
- **WHEN** le verrou d'admission porte le nonce du processus courant, sans admission synchrone en cours
- **THEN** le Node reprend ce verrou et traite la demande

#### Scenario: AC: verrou d'un autre processus
<!-- openspec-guard:test="bounded received drops > reclaims only its own replay lock and refuses an old foreign lock" -->
- **WHEN** le verrou porte un autre propriétaire dont la mort n'est pas prouvée (format T3.1b, autre poste, autre démarrage), même s'il semble ancien
- **THEN** le Node refuse la demande sans toucher au verrou

#### Scenario: AC: verrou d'un processus vivant
<!-- openspec-guard:test="bounded received drops > keeps a replay lock owned by another live process" -->
- **WHEN** le verrou appartient à un processus encore vivant de ce poste et de ce démarrage
- **THEN** le Node refuse la demande sans toucher au verrou

#### Scenario: AC: verrou sans propriétaire
<!-- openspec-guard:test="bounded received drops > requires manual removal of an ownerless replay lock before admission resumes" -->
- **WHEN** un verrou sans propriétaire lisible subsiste (dossier laissé par T3.1b), même ancien
- **THEN** le Node refuse toute admission jusqu'au retrait manuel après arrêt de tous les processus qui partagent ce `DROP_HOME`

#### Scenario: AC: ancienne sentinelle de reprise
<!-- openspec-guard:test="bounded received drops > never takes over a foreign replay lock even when its takeover sentinel is old" -->
- **WHEN** un verrou T3.1b et une sentinelle de reprise anciens subsistent
- **THEN** le Node refuse la demande et laisse le verrou en place

#### Scenario: AC: doublon d'une demande terminée
<!-- openspec-guard:test="replay admission through the engine > answers a duplicate of a finished request with its recorded outcome" -->
- **WHEN** le même demandeur renvoie une demande déjà refusée ou échouée
- **THEN** le Node renvoie la même erreur, sans nouvel accord

#### Scenario: AC: identifiant actif réutilisé par un autre pair
<!-- openspec-guard:test="replay admission through the engine > refuses another peer reusing an active drop id without revealing its state" -->
- **WHEN** un autre pair envoie l'identifiant d'une demande active
- **THEN** il reçoit `E_DENIED` sans l'état de la demande

#### Scenario: AC: résultat réel après un refus de doublon
<!-- openspec-guard:test="end to end, in memory: relay and three nodes > a real result still lands after an overtaking refusal or a premature delivered status, and funding is released once" -->
- **WHEN** un refus de doublon ou un `drop_status` annonçant une livraison précède le vrai résultat
- **THEN** le demandeur enregistre le vrai résultat et libère le financement une seule fois

#### Scenario: AC: horloge anti-rejeu en avance
<!-- openspec-guard:test="replay admission through the engine > refuses a request after clock rollback with E_EXPIRED and logs that the replay clock is ahead" -->
- **WHEN** l'horloge persistante est en avance sur l'horloge du Node
- **THEN** la demande reçoit `E_EXPIRED` sans accord et le journal indique `replay_clock_ahead`

#### Scenario: AC: doublon d'une demande active
<!-- openspec-guard:test="replay admission through the engine > answers a duplicate of an active request with its current state" -->
- **WHEN** une demande encore en attente ou en cours est reçue une seconde fois du même demandeur
- **THEN** le Node répond par un `drop_status` portant l'état courant, sans nouvel accord

#### Scenario: AC: issue finale conservée chez le demandeur
<!-- openspec-guard:test="end to end, in memory: relay and three nodes > a late executor update cannot rewrite a finished outbound drop" -->
- **WHEN** un `drop_error` ou un `drop_status` arrive après l'issue finale d'une demande
- **THEN** le demandeur conserve l'issue déjà reçue

#### Scenario: AC: décision de relecture reçue deux fois
<!-- openspec-guard:test="end to end, in memory: relay and three nodes > records one result and receipt when the approver repeats a review decision concurrently" -->
- **WHEN** deux décisions de relecture pour la même demande arrivent pendant l'envoi du résultat
- **THEN** l'exécuteur n'émet qu'un résultat et un reçu

#### Scenario: AC: délai de relecture pendant l'envoi
<!-- openspec-guard:test="end to end, in memory: relay and three nodes > does not expire a review while its accepted result is being sent" -->
- **WHEN** la relecture acceptée est en cours d'envoi et son délai expire
- **THEN** l'exécuteur ne produit pas de reçu d'expiration contradictoire

### Requirement: Nettoyage des écritures anti-rejeu échouées
Le Node MUST supprimer le fichier temporaire d'une écriture durable échouée, afin qu'une panne répétée n'accumule pas de fichiers hors de la borne anti-rejeu.

#### Scenario: AC: échec répété de l'écriture durable
<!-- openspec-guard:test="replay clock write failures > does not accumulate temporary files when durable writes repeatedly fail" -->
- **WHEN** chaque synchronisation échoue pendant plusieurs premières admissions d'un `DROP_HOME` neuf
- **THEN** le Node refuse chaque demande sans laisser de fichier temporaire

### Requirement: Panne passagère sans blocage de l'admission
Une erreur passagère d'écriture ou de synchronisation MUST refuser seulement la demande en cours, sans laisser le stockage anti-rejeu refuser les suivantes : un enregistrement dont la synchronisation a échoué est retiré du journal avant le refus, une compaction échouée est vidée pour ne jamais devenir le journal valide, et une migration ou une reprise interrompue recommence grâce à un marqueur écrit en premier et retiré en dernier.

#### Scenario: AC: panne passagère après création du marqueur
<!-- openspec-guard:test="replay clock write failures > cuts off a record whose flush failed, so the refused id is admitted once and admission keeps working" -->
- **WHEN** la synchronisation du journal échoue après l'écriture de l'enregistrement d'une nouvelle demande
- **THEN** cette demande est refusée, son enregistrement est retiré, l'admission suivante réussit et le même identifiant est admis au plus une fois

#### Scenario: AC: empreinte déjà en place
<!-- openspec-guard:test="replay clock write failures > keeps admitting after a transient sync failure at any step of a claim that compacts the journal" -->
- **WHEN** seule la synchronisation qui vide l'ancien journal échoue, après celle du journal compacté
- **THEN** le journal compacté reste le seul valide au redémarrage, le même identifiant est refusé comme doublon et une autre demande est admise

#### Scenario: AC: panne passagère pendant la purge
<!-- openspec-guard:test="replay clock write failures > keeps admitting after a transient sync failure at any step of a claim that compacts the journal" -->
- **WHEN** une synchronisation échoue à n'importe quelle étape d'une admission qui compacte le journal
- **THEN** cette demande est refusée, puis le même identifiant est admis au plus une fois et une autre demande est admise, sans réparation manuelle

#### Scenario: AC: panne passagère pendant la première admission
<!-- openspec-guard:test="replay clock write failures > keeps admitting after a transient sync failure at any step of the first claim on a fresh home" -->
- **WHEN** une synchronisation échoue pendant la première admission d'un `DROP_HOME` neuf
- **THEN** la création reprend à l'admission suivante au lieu de refuser toute demande

#### Scenario: AC: panne passagère pendant la migration
<!-- openspec-guard:test="replay clock write failures > keeps admitting after a transient sync failure at any step of the upgrade of a format-2 store" -->
- **WHEN** une synchronisation échoue pendant la migration d'un stockage de format 2
- **THEN** la migration reprend à l'admission suivante et l'identifiant migré reste refusé

#### Scenario: AC: panne passagère pendant la reprise après quarantaine
<!-- openspec-guard:test="replay clock write failures > keeps admitting after a transient sync failure at any step of the restart after a quarantine" -->
- **WHEN** une synchronisation échoue pendant la première admission qui suit une quarantaine
- **THEN** la reprise recommence à l'admission suivante

#### Scenario: AC: empreinte antérieure aux planchers
<!-- openspec-guard:test="bounded received drops > verifies a digest written before floors and refuses to migrate a store that lost a marker" -->
- **WHEN** l'empreinte durable a été écrite par une version qui ne portait pas de plancher
- **THEN** elle est vérifiée sur tout le jeu avant la migration, et la perte d'un marqueur récent est refusée

### Requirement: Mémoire des demandes exécutées bornée
Le Node MUST limiter à 1 024 les demandes reçues encore actives en mémoire, y compris quand plusieurs demandes sont traitées en même temps. Dès qu'une issue est envoyée, il MUST libérer l'entrée complète ; il MAY conserver pendant au plus 30 minutes un résumé borné du refus pour répondre au même demandeur. La suppression de mémoire MUST NOT supprimer le marqueur anti-rejeu durable ni relancer une demande.

#### Scenario: AC: libération après issue
<!-- openspec-guard:test="replay admission through the engine > frees a delivered request without reopening its durable replay marker" -->
- **WHEN** une demande se termine par résultat, refus, expiration ou erreur
- **THEN** l'entrée contenant son entrée, sa configuration et ses outils sort de la mémoire active, tandis que son identifiant reste protégé contre le rejeu

#### Scenario: AC: doublon après libération
<!-- openspec-guard:test="replay admission through the engine > answers a duplicate of a finished request with its recorded outcome" -->
- **WHEN** le demandeur renvoie un identifiant terminé encore dans la fenêtre anti-rejeu
- **THEN** aucun nouvel accord n'est créé ; une erreur finale mémorisée peut être répétée au même demandeur, sans révéler son contenu à un autre pair

#### Scenario: AC: durée maximale du résumé de refus
<!-- openspec-guard:test="replay admission through the engine > expires a finished-error summary within 30 minutes even for a future UUIDv7" -->
- **WHEN** un refus concerne un UUIDv7 avancé de cinq minutes par rapport à l'horloge locale
- **THEN** son résumé mémoire disparaît au plus tard 30 minutes après le refus, sans modifier le marqueur durable

#### Scenario: AC: plafond de demandes actives
<!-- openspec-guard:test="replay admission through the engine > refuses another request before consent when active execution memory is full" -->
- **WHEN** 1 024 demandes reçues sont encore actives
- **THEN** une demande supplémentaire reçoit `E_RATE` avant accord ou exécution, sans évincer une demande active

#### Scenario: AC: plafond sous livraison concurrente
<!-- openspec-guard:test="bounded executor memory under concurrent delivery > never exceeds the active execution cap when requests are admitted concurrently" -->
- **WHEN** plusieurs demandes valides arrivent ensemble alors qu'il ne reste qu'une place active
- **THEN** une seule est admise et les autres reçoivent `E_RATE`, sans dépasser 1 024 demandes actives

### Requirement: Mémoire des demandes émises bornée
Le Node MUST conserver au plus 1 024 demandes émises en mémoire. Il MUST évincer d'abord les plus anciennes demandes terminées ; si toutes les places sont actives, il MUST refuser la nouvelle demande avec une erreur de capacité explicite sans créer de financement ni envoyer d'enveloppe. L'API locale MUST exposer cette saturation par HTTP 429.

#### Scenario: AC: historique local borné
<!-- openspec-guard:test="bounded requester memory > evicts the oldest finished drop while retaining every active drop" -->
- **WHEN** plus de 1 024 demandes sont émises et des issues terminées existent
- **THEN** le Node ne garde que 1 024 demandes au plus et préserve toutes celles qui sont encore actives

#### Scenario: AC: émission à capacité
<!-- openspec-guard:test="local API > reports requester capacity as E_RATE/429 for /drops and /ask" -->
- **WHEN** les 1 024 demandes émises sont encore actives
- **THEN** le Node refuse une nouvelle demande avec `E_RATE` et l'API locale répond HTTP 429 sans envoyer la demande ni prélever de financement

### Requirement: Boîte d'approbation bornée
Le Node MUST conserver au plus 1 024 cartes d'approbation ou de relecture reçues. Il MUST refuser une carte dont l'expiration est passée ou avance de plus de 15 minutes, et MUST refuser tout remplacement d'une carte encore visible portant le même `dropId`, même depuis un autre pair. Il MUST NOT évincer une carte encore valide pour accepter une autre carte. Une carte refusée MUST produire un diagnostic local sans contenu sensible.

#### Scenario: AC: saturation de la boîte d'approbation
<!-- openspec-guard:test="bounded transient node memory > refuses extra approval cards and excessive expiration without evicting a pending card" -->
- **WHEN** 1 024 cartes non expirées occupent la boîte d'approbation
- **THEN** une nouvelle carte est refusée sans effacer les cartes déjà visibles

#### Scenario: AC: expiration abusive d'une carte
<!-- openspec-guard:test="bounded transient node memory > refuses extra approval cards and excessive expiration without evicting a pending card" -->
- **WHEN** un pair envoie une carte dont `expiresAt` dépasse l'heure courante de plus de 15 minutes
- **THEN** le Node l'ignore sans l'ajouter à la boîte d'approbation

#### Scenario: AC: collision d'identifiant dans la boîte d'approbation
<!-- openspec-guard:test="bounded transient node memory > keeps the first approval and review when another paired peer reuses their drop ids" -->
- **WHEN** un pair envoie une approbation ou une relecture avec le `dropId` d'une carte déjà visible
- **THEN** la première carte, son émetteur et son contenu restent intacts ; le remplacement est refusé et diagnostiqué

### Requirement: File hors ligne bornée
Le Node MUST conserver au plus 1 024 enveloppes en attente de reconnexion, en comptant l'enveloppe dont l'envoi est en cours. Un seul vidage de file peut être actif à la fois. Il MUST purger les enveloppes expirées avant une nouvelle mise en file ; à saturation il MUST abandonner l'enveloppe la plus ancienne et journaliser un code stable, sans laisser croître la mémoire. Une exception de transport MUST être traitée comme une panne hors ligne et diagnostiquée.

#### Scenario: AC: panne réseau prolongée
<!-- openspec-guard:test="bounded transient node memory > caps offline envelopes and logs the oldest envelope dropped at capacity" -->
- **WHEN** le relais reste indisponible pendant plus de 1 024 envois
- **THEN** la file reste sous son plafond et chaque perte par saturation est journalisée

#### Scenario: AC: ordre de la file pendant un vidage concurrent
<!-- openspec-guard:test="bounded transient node memory > requeues an older envelope ahead of newer sends during a concurrent flush" -->
- **WHEN** une ancienne enveloppe échoue à nouveau pendant qu'un envoi plus récent rejoint la file
- **THEN** l'ancienne garde sa place chronologique et reste la première à être renvoyée ou abandonnée à saturation

#### Scenario: AC: vidages concurrents et plafond global
<!-- openspec-guard:test="bounded transient node memory > serializes concurrent flushes and counts the held send against outbox capacity" -->
- **WHEN** deux vidages démarrent pendant qu'un envoi est suspendu et que la file se remplit
- **THEN** une seule copie part au transport et les enveloppes retenues, y compris celle en vol, restent sous le plafond

#### Scenario: AC: tentative unique par vidage
<!-- openspec-guard:test="bounded transient node memory > attempts each queued envelope once per flush even when an older one is requeued" -->
- **WHEN** plusieurs enveloppes sont en file et la première est replacée après un nouvel échec
- **THEN** chacune est tentée une seule fois pendant ce vidage et reste disponible pour un prochain essai

#### Scenario: AC: transport qui échoue après accord
<!-- openspec-guard:test="replay admission through the engine > does not strand an approved request when transport throws on status" -->
- **WHEN** le transport rejette l'envoi d'un statut après une décision `allow_once`
- **THEN** le Node n'abandonne pas la demande dans un état intermédiaire retenu indéfiniment

### Requirement: Refus explicite du relais côté demandeur
Le Node MUST traiter `E_RATE`, `E_QUEUE_FULL` ou l'indisponibilité du relais à la demande initiale comme une non-livraison. Il MUST retirer l'entrée locale active, demander la révocation de la clé plafonnée créée pour cette demande et exposer `E_RATE` à l'appelant ; une demande initiale non livrée MUST NOT rester dans la file volatile, et aucun résultat tardif ne doit recréer une demande effacée.

#### Scenario: AC: relais refuse la demande initiale
<!-- openspec-guard:test="bounded requester memory > releases funding and active memory when the relay returns E_RATE" -->
- **WHEN** le relais refuse un `drop_request` avec `E_RATE` ou `E_QUEUE_FULL`
- **THEN** la demande n'occupe pas une place active, une révocation de la clé plafonnée est déclenchée une fois et l'API locale répond 429 ; un échec fournisseur passe en reprise bornée

#### Scenario: AC: relais indisponible à la demande initiale
<!-- openspec-guard:test="bounded requester memory > does not leave an offline drop request in volatile memory" -->
- **WHEN** le relais est hors ligne au moment d'émettre une nouvelle demande
- **THEN** la demande est retirée, la révocation de sa clé plafonnée est déclenchée, l'API locale répond 429 et aucun `drop_request` volatile ne reste en file

#### Scenario: AC: refus temporaire au vidage de file
<!-- openspec-guard:test="bounded transient node memory > keeps a queued envelope after a temporary relay refusal on flush" -->
- **WHEN** le relais répond `E_RATE` ou `E_QUEUE_FULL` à une enveloppe déjà en file
- **THEN** le Node garde l'enveloppe jusqu'à son expiration et journalise le refus, sans la perdre silencieusement

#### Scenario: AC: relais refuse une destination inconnue
<!-- openspec-guard:test="bounded requester memory > fails a drop at once, with E_SCHEMA, when the relay refuses its envelope for an owner it does not admit" -->
- **WHEN** le relais refuse définitivement la demande initiale avec `E_SCHEMA`, par exemple pour un propriétaire qu'il n'admet pas
- **THEN** la demande passe aussitôt à l'état `failed` avec `E_SCHEMA`, la clé plafonnée est libérée une fois et la demande n'attend pas son expiration

#### Scenario: AC: enveloppe initiale trop grande
<!-- openspec-guard:test="bounded requester memory > releases funding and active memory when the initial envelope is too large" -->
- **WHEN** la demande initiale dépasse la taille maximale de l'enveloppe avant envoi au relais
- **THEN** la demande locale est retirée, la révocation de la clé plafonnée est déclenchée et l'API locale répond `E_TOO_LARGE` sans fausse réussite ni place active immobilisée

#### Scenario: AC: enveloppe trop grande via /ask
<!-- openspec-guard:test="local API > reports requester capacity as E_RATE/429 for /drops and /ask" -->
- **WHEN** une demande routée par `/ask` dépasse la taille maximale de l'enveloppe
- **THEN** l'API locale répond HTTP 413 avec `E_TOO_LARGE` et indique les routes éventuellement déjà émises

### Requirement: Révocation différée des clés plafonnées
Si la révocation échoue, le Node MUST conserver uniquement le hash de la clé en mémoire, réessayer avec délai et journaliser sans secret jusqu'à confirmation ou expiration après deux heures. Il MUST limiter à 8 192 les clés et créations en cours, réserver une place avant l'appel fournisseur, refuser un doublon ou un dépassement avec `E_RATE` avant cet appel et libérer la place si la création échoue.

#### Scenario: AC: révocation différée après refus du relais
<!-- openspec-guard:test="OpenRouter capped keys > retries a failed deletion on node ticks after relay refusal" -->
- **WHEN** le relais refuse la demande puis le fournisseur échoue à révoquer sa clé plafonnée
- **THEN** le Node libère la place de la demande, conserve seulement le hash pour une nouvelle tentative bornée et réessaie sans attendre une autre demande

#### Scenario: AC: plafond des révocations en attente
<!-- openspec-guard:test="OpenRouter capped keys > refuses to mint beyond the pending-key cap before contacting the provider" -->
- **WHEN** 8 192 clés plafonnées non expirées attendent encore leur fin ou une révocation confirmée
- **THEN** aucune clé supplémentaire n'est créée, `E_RATE` est retourné et une place se libère après leur expiration automatique

#### Scenario: AC: créations plafonnées simultanées
<!-- openspec-guard:test="OpenRouter capped keys > reserves pending-key capacity before concurrent provider calls and refuses duplicate drop ids" -->
- **WHEN** plusieurs créations sont en cours avant la réponse du fournisseur et que le plafond est atteint
- **THEN** les suivantes et le doublon d'une demande sont refusés avant tout autre appel fournisseur

#### Scenario: AC: réservation libérée après refus fournisseur
<!-- openspec-guard:test="OpenRouter capped keys > frees a reserved key slot when the provider rejects creation" -->
- **WHEN** le fournisseur refuse la création d'une clé plafonnée
- **THEN** la réservation est libérée et une demande ultérieure peut créer sa clé

### Requirement: Raccordement local contrôlé des agents
Le Node SHALL analyser uniquement les configurations documentées des treize clients connus et proposer, par agent, un état et l'ajout précis du connecteur MCP drop. Cette analyse MUST NOT exécuter un serveur MCP, scanner le disque ou contacter le réseau. L'aperçu MUST exclure les valeurs de secrets, arguments et en-têtes existants. Une configuration illisible ou invalide produit une erreur pour cet agent, jamais une configuration vide de remplacement.

#### Scenario: AC-CONNECT-01 — analyse bornée et expurgée
<!-- openspec-guard:test="local agent onboarding (T3.3) > AC-CONNECT-01 analyzes known adapters without exposing secret values" -->
- **WHEN** les quatre adaptateurs déclarent des serveurs avec des valeurs secrètes
- **THEN** l'analyse lit seulement leurs emplacements connus, n'exécute aucun serveur et ne renvoie aucune valeur sensible

#### Scenario: AC-CONNECT-04 — erreur par agent sans écrasement
<!-- openspec-guard:test="local agent onboarding (T3.3) > AC-CONNECT-04 and AC-CONNECT-05 refuses malformed and changed files without overwriting" -->
- **WHEN** une configuration est invalide, une CLI manque ou l'accès est refusé
- **THEN** cet agent reçoit une erreur explicite et sa configuration reste intacte

Le Node MUST exiger une empreinte correspondant à l'aperçu confirmé avant chaque modification. Une entrée drop identique est sans effet ; une entrée différente est un conflit visible. Il MUST ne modifier que l'entrée drop annoncée et ne publier aucune capacité. Les écritures de fichiers MUST préserver les autres entrées et utiliser une sauvegarde locale privée bornée ; la déconnexion MUST retirer seulement l'entrée drop qu'il a installée.

#### Scenario: AC-CONNECT-02 — sélection confirmée sans publication
<!-- openspec-guard:test="local agent onboarding (T3.3) > AC-CONNECT-02 and AC-CONNECT-03 changes only the selected entry, then becomes idempotent" -->
- **WHEN** le propriétaire confirme une sélection d'agents après l'aperçu
- **THEN** seules les entrées drop annoncées pour cette sélection changent et aucune capacité n'est publiée

#### Scenario: AC-CONNECT-03 — répétition et conflit
<!-- openspec-guard:test="local agent onboarding (T3.3) > AC-CONNECT-03 refuses an existing entry with different settings" -->
- **WHEN** l'installation est répétée, puis rencontre une entrée drop différente
- **THEN** la répétition n'écrit rien et l'entrée différente n'est pas remplacée silencieusement

#### Scenario: AC-CONNECT-05 — modification concurrente ou interruption
<!-- openspec-guard:test="local agent onboarding (T3.3) > AC-CONNECT-05 preserves a competing write during the JSON transaction" -->
- **WHEN** une configuration change après l'aperçu ou une écriture s'interrompt
- **THEN** le Node arrête l'action de cet agent et conserve le contenu tiers, avec une sauvegarde privée exploitable

#### Scenario: AC-CONNECT-06 — déconnexion sélective
<!-- openspec-guard:test="local agent onboarding (T3.3) > AC-CONNECT-06 removes only the owned entry after a third-party addition" -->
- **WHEN** un tiers ajoute une autre entrée après le raccordement
- **THEN** la déconnexion retire seulement drop et conserve l'ajout tiers

### Requirement: Découverte sur le réseau local
En mode local actif, le Node SHALL annoncer le service `_drop._tcp` sous un nom aléatoire, avec un jeton tournant que seuls ses pairs reconnaissent, et jamais son identifiant ; il SHALL découvrir les annonces de ses pairs. Il MUST ignorer toute adresse annoncée qui n'est pas privée ; une adresse de bouclage n'est retenue que dans les tests et le banc de simulation. Il MUST borner le nombre d'annonces retenues.

#### Scenario: AC: adresses publiques ignorées
<!-- openspec-guard:test="local network (T4.2) > keeps only private addresses from discovery, loopback only when allowed" -->
- **WHEN** une annonce porte une adresse publique, une adresse de bouclage et une adresse privée
- **THEN** seule l'adresse privée est retenue

#### Scenario: AC: annonce tournante
<!-- openspec-guard:test="local network privacy (T4.2c) > announces only a rotating tag that paired peers recognize, never the node id" -->
- **WHEN** un nœud annonce son service pendant deux époques de 15 minutes
- **THEN** l'annonce ne contient pas son identifiant, son nom et son jeton changent, un pair qui a sa clé le reconnaît et un inconnu non

### Requirement: Session locale authentifiée
Une session locale SHALL commencer par un défi signé dans les deux sens avec la clé Ed25519 annoncée ; aucune enveloppe MUST NOT être traitée avant les deux preuves. En sortie, le Node MUST NOT ouvrir de session que vers un pair appairé ou l'inviteur d'un code en cours, et l'identifiant prouvé MUST être celui visé. En entrée, il MUST refuser une clé inconnue hors invitation en cours.

#### Scenario: AC: imposteur refusé
<!-- openspec-guard:test="local network (T4.2) > refuses a peer whose proof does not match the announced or expected key" -->
- **WHEN** un pair annonce l'identifiant d'un autre ou ne prouve pas sa clé
- **THEN** la session est fermée sans qu'aucune enveloppe ne passe

#### Scenario: AC: clé inconnue refusée hors invitation
<!-- openspec-guard:test="local network (T4.2) > refuses an unknown key when no invite is live" -->
- **WHEN** une clé ni appairée ni en cours d'appairage ouvre une session et qu'aucune invitation n'est en cours
- **THEN** la session est fermée avec `E_LAN_UNKNOWN` et rien n'est transmis au moteur

### Requirement: Robustesse de l'écoute locale
Une trame trop grande, hors schéma ou trop fréquente SHALL fermer la seule session concernée, jamais le Node. Le nombre de connexions et de sessions MUST être borné ; une adresse injoignable MUST se traduire par un échec d'envoi local, sans exception non rattrapée.

#### Scenario: AC: trames invalides sans arrêt du Node
<!-- openspec-guard:test="local network (T4.2) > survives malformed, oversized and early frames, and dead addresses" -->
- **WHEN** un client envoie une trame de 600 Kio, puis du texte hors JSON, et qu'un pair annoncé ne répond pas
- **THEN** ces sessions sont fermées, l'envoi rend `unreachable` et le Node accepte encore une session valide

### Requirement: Chemin local préféré
Une enveloppe vers un pair joignable par une session locale authentifiée SHALL passer par elle ; sinon le Node SHALL utiliser le relais configuré, et sinon la file d'envoi. Une enveloppe ne MUST compter comme remise localement qu'après un accusé signé par la clé du destinataire ; sans cet accusé, le Node SHALL passer au relais.

#### Scenario: AC: échange sans relais
<!-- openspec-guard:test="local network (T4.2) > completes a consented drop between two paired nodes with no relay at all" -->
- **WHEN** deux Nodes appairés se découvrent localement et qu'aucun relais n'est joignable
- **THEN** une demande, sa décision et son résultat circulent par la session locale

#### Scenario: AC: accusé signé exigé
<!-- openspec-guard:test="local network (T4.2) > counts an envelope as delivered only after the peer signed its acknowledgement" -->
- **WHEN** l'accusé de réception d'une enveloppe n'est pas signé par la clé du destinataire
- **THEN** l'envoi local rend `unreachable` et la session est fermée

### Requirement: Mode local refusé ou désactivé
Si le système refuse l'accès au réseau local ou si l'écoute est impossible, le Node SHALL journaliser `E_LAN_DENIED` et continuer par le relais. Avec `lan: false` dans sa configuration, il MUST n'écouter ni n'annoncer quoi que ce soit sur le réseau local.

#### Scenario: AC: mode local désactivé
<!-- openspec-guard:test="local network (T4.2) > neither listens nor announces when the local mode is off" -->
- **WHEN** le Node démarre avec `lan: false`
- **THEN** aucun port local n'est ouvert pour le réseau et aucune annonce n'est faite

#### Scenario: AC: écoute impossible
<!-- openspec-guard:test="local network (T4.2) > reports E_LAN_DENIED and keeps going when the local port cannot be opened" -->
- **WHEN** le port local est déjà pris au démarrage
- **THEN** le Node journalise `E_LAN_DENIED`, son état local est `denied` et le démarrage continue

### Requirement: Réponse à la main par l'approbateur
Sur une carte d'approbation en attente, le Node de l'approbateur SHALL permettre de répondre à la main par un `HumanAnswer`, ce qui vaut consentement pour cette seule demande. Il MUST valider la réponse et y chercher des secrets avant tout envoi ; un refus laisse la carte en attente. La route locale `POST /ui/answer` MUST refuser avec un code stable, et `/ui/pending` MUST nommer l'exécuteur d'après les pairs locaux.

#### Scenario: AC: réponse livrée avec le même reçu
<!-- openspec-guard:test="human answer (T4.3) > delivers a hand-written answer with the same consent and a receipt marked human" -->
- **WHEN** l'approbateur répond « Le déploiement est prévu jeudi » à une demande en attente
- **THEN** le demandeur reçoit ce texte, la capacité n'est pas exécutée et le reçu signé porte `answeredBy: 'human'`

#### Scenario: AC: secret bloqué avant envoi
<!-- openspec-guard:test="human answer (T4.3) > refuses a hand-written answer that carries a secret, before anything is sent" -->
- **WHEN** la réponse contient une clé d'API reconnue
- **THEN** le Node refuse avec `E_SECRET_DETECTED`, rien n'est envoyé et la carte reste en attente pour une correction

#### Scenario: AC: route locale de réponse
<!-- openspec-guard:test="human answer (T4.3) > answers by hand through the panel route, which refuses an empty or oversized answer" -->
- **WHEN** le panneau envoie à `POST /ui/answer` une réponse vide, mal formée, au nom trop long, trop grosse ou dépassant le corps permis, puis valide
- **THEN** chacune est refusée avec son code (`E_SCHEMA`, `E_TOO_LARGE`, 413 pour le corps) et la dernière est livrée ; `/ui/pending` nomme l'exécuteur d'après les pairs locaux

### Requirement: Contrôle de la réponse humaine par l'exécuteur
L'exécuteur MUST n'accepter `human_answer` que d'un approbateur de la carte pour un Drop en `awaiting_approval`, refaire la validation et la recherche de secrets, livrer sans exécuter la capacité et écrire le reçu signé. Un refus MUST ne rien dire au demandeur du contenu refusé.

#### Scenario: AC: seul l'approbateur répond
<!-- openspec-guard:test="human answer (T4.3) > accepts a hand-written answer from a remote approver and from no one else" -->
- **WHEN** un pair qui n'est pas approbateur envoie `human_answer`, puis l'approbateur distant le fait, puis un nœud approbateur qui a sauté le contrôle envoie un secret
- **THEN** le premier est ignoré, seule la réponse de l'approbateur est livrée, et le secret est refusé par l'exécuteur avec un message qui n'en dit rien

### Requirement: Publication d'un fait
Le Node SHALL permettre au propriétaire de publier, modifier (nouvelle révision signée) et retirer un fait. Il MUST refuser un fait qui contient un secret reconnu, garder les faits sous `DROP_HOME` en mode `0600` et garder la trace d'un fait retiré.

#### Scenario: AC: publication et stockage
<!-- openspec-guard:test="published facts (T4.4) > publishes, edits and retires a signed fact, refuses a secret, and keeps facts privately on disk" -->
- **WHEN** le propriétaire publie un fait, le modifie, tente d'en publier un avec une clé d'API, puis le retire
- **THEN** la révision augmente et la signature reste valide, le secret est refusé avec `E_SECRET_DETECTED`, le fait retiré reste listé, et `facts.json` est en mode `0600`

### Requirement: Service d'un fait sans décision
Le Node SHALL annoncer un fait seulement dans le catalogue des pairs de son public, tant qu'il est actif et non expiré, et le servir sans carte d'approbation avec un reçu signé. Il MUST refuser un fait retiré, expiré, hors public ou d'une ancienne révision par le même `E_SCHEMA` « Fait indisponible. », revérifier après chaque attente, limiter chaque pair à 10 faits par minute et ne jamais défaire un retrait ou une révision concurrente.

#### Scenario: AC: catalogue selon le public
<!-- openspec-guard:test="published facts (T4.4) > lists a fact only in the catalog of its audience" -->
- **WHEN** un fait est réservé à un pair choisi
- **THEN** seul ce pair le voit dans son catalogue

#### Scenario: AC: fait servi sans décision
<!-- openspec-guard:test="published facts (T4.4) > serves a fact without a decision, with a signed receipt marked fact" -->
- **WHEN** un pair du public demande un fait actif
- **THEN** il le reçoit sans carte d'approbation chez le propriétaire, et le compteur de service augmente

#### Scenario: AC: fenêtre de cadence bornée
<!-- openspec-guard:test="published facts (T4.4) > keeps a bounded fact-rate window per peer however fast it asks" -->
- **WHEN** un pair demande des faits bien plus vite que 10 par minute, par un chemin direct sans quota du relais
- **THEN** les demandes en trop sont refusées sans être mémorisées, et la fenêtre gardée pour ce pair ne dépasse pas la limite

#### Scenario: AC: fait indisponible
<!-- openspec-guard:test="published facts (T4.4) > refuses a retired, expired, out-of-audience or outdated fact without saying which" -->
- **WHEN** le fait demandé est retiré, expiré, hors public ou d'une ancienne révision
- **THEN** le demandeur reçoit `E_SCHEMA` « Fait indisponible. » dans tous les cas

#### Scenario: AC: concurrence et débit
<!-- openspec-guard:test="published facts (T4.4) > keeps a retire made while a fact is being served, and limits fact requests per peer" -->
- **WHEN** le propriétaire retire un fait pendant qu'il est servi, un retrait et une modification partent ensemble, puis un pair demande onze faits en une minute
- **THEN** le retrait tient, une seule des deux actions gagne, et la onzième demande reçoit `E_RATE`

#### Scenario: AC: stockage illisible
<!-- openspec-guard:test="published facts (T4.4) > serves no fact from an unreadable store, keeps the catalog, and mints no capped key for a fact" -->
- **WHEN** `facts.json` devient illisible, et qu'un demandeur qui paie demande un fait
- **THEN** aucun fait n'est servi mais les capacités restent au catalogue, et aucune clé plafonnée n'est créée pour un fait

### Requirement: Contrôle d'un fait reçu
Le Node demandeur MUST vérifier qu'un fait reçu est signé par l'exécuteur, qu'il correspond à la carte demandée et qu'il n'est pas expiré, et refuser l'empreinte d'un fait pour une capacité qui n'en est pas un ; sinon il MUST le rejeter avec `E_OUTPUT_INVALID`.

#### Scenario: AC: fait reçu invalide
<!-- openspec-guard:test="published facts (T4.4) > rejects at the requester a fact whose signature or validity does not hold" -->
- **WHEN** un exécuteur renvoie un fait mal signé ou expiré
- **THEN** le demandeur n'en garde aucun résultat et enregistre `E_OUTPUT_INVALID`

### Requirement: Fait servi par ask_team
« Demander à mon équipe » SHALL demander d'abord, trois au plus, les faits en ligne dont un mot-clé ou le sujet d'au moins trois lettres figure dans la question, sans modèle ; sinon le routage habituel s'applique. Les routes locales SHALL permettre de lister, publier, modifier et retirer.

#### Scenario: AC: question servie par un fait
<!-- openspec-guard:test="published facts (T4.4) > answers ask_team with a fact whose keyword appears in the question, before any capability" -->
- **WHEN** une question contient un mot-clé d'un fait visible
- **THEN** ce fait est demandé et servi sans décision, avant toute capacité

#### Scenario: AC: termes de routage ignorés
<!-- openspec-guard:test="published facts (T4.4) > ignores routing terms too short or in another script, and offline facts" -->
- **WHEN** un fait n'a que des mots-clés d'une ou deux lettres, en emoji ou dans une autre écriture, ou que son propriétaire est hors ligne
- **THEN** il ne capte pas la question

#### Scenario: AC: routes locales des faits
<!-- openspec-guard:test="published facts (T4.4) > manages facts through the panel routes" -->
- **WHEN** le panneau liste, publie, modifie puis retire un fait par les routes locales
- **THEN** chaque action aboutit et un refus porte son code

### Requirement: Treize clients MCP détectés sans modèle
Le Node SHALL reconnaître les treize clients de D55 par leurs emplacements documentés sur macOS, Windows et Linux, en JSON, JSONC, TOML ou YAML, et lister pour chacun s'il est installé, si drop y est raccordé et quels serveurs MCP il déclare, sans jamais afficher de valeur secrète. Un client MUST être dit installé par son application, son binaire ou son extension, jamais par un dossier de configuration seul.

#### Scenario: AC: lecture des treize clients
<!-- openspec-guard:test="mcp clients (T4.5) > reads each client's documented global configuration, including JSONC, TOML and YAML, without any secret value" -->
- **WHEN** chaque client a sa configuration globale avec un serveur portant un secret
- **THEN** l'analyse liste le serveur pour chacun, avec seulement des noms et des hôtes

#### Scenario: AC: installation prouvée
<!-- openspec-guard:test="mcp clients (T4.5) > tells an installed client by its app or binary, never by a configuration folder alone" -->
- **WHEN** seuls les dossiers de configuration de Zed, goose, Devin et Gemini existent
- **THEN** ces clients sont dits absents, et présents dès que leur application ou leur binaire existe

#### Scenario: AC: installation reconnue sur chaque système
<!-- openspec-guard:test="all thirteen clients connected automatically (T4.22) > finds apps and executables the way each system installs them, never from a configuration folder alone" -->
- **WHEN** les clients sont installés comme chaque système les installe : application dans `/Applications`, dossier sous `%LOCALAPPDATA%\Programs` ou `Program Files`, fichier `.desktop`, binaire sur un `PATH` séparé par `;` avec les extensions de `PATHEXT` sous Windows
- **THEN** chacun est dit installé sur son système, et aucun ne l'est sans application, binaire ni extension

#### Scenario: AC: emplacements déplacés par l'environnement
<!-- openspec-guard:test="all thirteen clients connected automatically (T4.22) > honours the documented overrides of each location on the real home only" -->
- **WHEN** une variable documentée déplace une configuration (`XDG_CONFIG_HOME`, `APPDATA`, `CODEX_HOME`, `GEMINI_CLI_HOME`, `OPENCODE_CONFIG`, `GOOSE_PATH_ROOT`, `CLINE_DIR`)
- **THEN** le fichier lu et écrit suit la variable si elle est absolue, l'ignore sinon, et un dossier personnel donné explicitement ne prend jamais l'environnement du processus

### Requirement: Configurations par projet
Le Node SHALL lire les configurations par projet seulement dans les projets que Claude Code et Codex connaissent déjà et dans les dossiers ajoutés depuis le panneau (50 au plus, ni la racine ni le dossier personnel), sans jamais parcourir le disque, et MUST ne lire que des fichiers réguliers de 1 Mio au plus.

#### Scenario: AC: projets connus ou ajoutés
<!-- openspec-guard:test="mcp clients (T4.5) > lists project configurations only for known or added projects, never by scanning the disk" -->
- **WHEN** un projet connu de Claude Code, un projet connu de Codex, un dossier ajouté et un dossier inconnu portent des configurations, l'une étant un lien vers `/dev/zero`
- **THEN** seuls les trois premiers apparaissent, le lien est ignoré sans attente, et le dossier personnel n'est jamais un projet

### Requirement: Inviteur trouvable pendant l'invitation
Tant qu'une invitation court, le Node SHALL ajouter à son annonce un jeton tiré du code à usage unique, que seul le détenteur du code reconnaît ; ce jeton MUST disparaître quand l'invitation expire ou est utilisée.

#### Scenario: AC: invitation reconnue puis oubliée
<!-- openspec-guard:test="local network privacy (T4.2c) > lets the invitee find the inviter through the invite only while it is live" -->
- **WHEN** l'invité cherche l'inviteur pendant puis après l'invitation
- **THEN** il le trouve pendant, plus après

### Requirement: Clé de découverte partagée avec les pairs
Le Node SHALL tirer une clé de découverte de 32 octets, la garder sous `DROP_HOME` en mode `0600` et l'envoyer chiffrée, par `lan_key`, à chaque pair à l'appairage, aux pairs présentés par l'équipe et à chaque démarrage. Il MUST n'accepter une clé que d'un pair connu, pour lui-même, et garder les clés des pairs à part, en `0600`.

#### Scenario: AC: clé partagée et privée
<!-- openspec-guard:test="local network privacy (T4.2c) > shares its discovery key with each paired peer and keeps it private on disk" -->
- **WHEN** deux nœuds s'appairent, puis qu'un inconnu envoie une clé
- **THEN** chacun garde la clé de l'autre dans un fichier `0600`, et la clé de l'inconnu est ignorée

### Requirement: Reprise après un refus passager
Après un refus de la découverte ou de l'écoute locale, le Node SHALL réessayer à 30 s, 1 min, 2 min puis toutes les 5 min, repasser à `on` dès que ça marche et journaliser chaque changement d'état.

#### Scenario: AC: reprise
<!-- openspec-guard:test="local network privacy (T4.2c) > recovers from a passing refusal with growing delays" -->
- **WHEN** la découverte échoue deux fois puis réussit
- **THEN** l'état passe de `denied` à `on`, après des délais croissants

### Requirement: Silence envers une connexion sans secret
Sur une session locale, le Node qui se connecte SHALL d'abord prouver qu'il détient la clé de découverte du nœud visé ou le jeton d'une invitation en cours ; le nœud joint MUST ne rien envoyer, ni identifiant ni raison de fermeture, tant que cette preuve manque, et le nœud qui se connecte MUST ne dire qui il est qu'après une réponse prouvant le même secret.

#### Scenario: AC: rien pour un inconnu
<!-- openspec-guard:test="local network privacy (T4.2c) > says nothing to a connection that cannot knock with a key it holds" -->
- **WHEN** une connexion se tait, frappe avec un mauvais secret ou dit bonjour d'emblée, puis qu'un nœud rejoue le jeton d'un pair à sa propre adresse
- **THEN** la connexion ne reçoit rien, et le nœud qui appelle ce faux pair n'envoie jamais son identifiant

### Requirement: Voie Internet par iroh
Le Node SHALL pouvoir joindre un pair par iroh quand le mode Internet est actif : programme `drop-iroh` avec la même clé que l'identité drop, sans annuaire ni relais n0 sauf choix explicite. Une enveloppe ne MUST compter comme remise qu'après un accusé signé par la clé du destinataire. Le programme MUST refuser la connexion d'un nœud qui n'est ni pair ni en appairage, sauf pendant une invitation vivante (D60).

#### Scenario: AC: identité iroh issue de drop
<!-- openspec-guard:test="internet (T4.2b) > derives the iroh identity from the drop key, so the iroh id is the drop node id" -->
- **WHEN** le programme démarre avec la graine d'une identité drop
- **THEN** son identifiant iroh est l'identifiant drop

#### Scenario: AC: échange direct avec accusé
<!-- openspec-guard:test="internet (T4.2b) > delivers an envelope directly between two nodes with no relay, with a signed acknowledgement" -->
- **WHEN** deux pairs connaissent leurs adresses directes et qu'aucun relais n'est configuré
- **THEN** une enveloppe passe par iroh et compte comme remise après l'accusé signé

#### Scenario: AC: non-pair refusé
<!-- openspec-guard:test="internet (T4.2b) > refuses a connection from a node that is not a paired peer" -->
- **WHEN** un nœud qui n'est pas un pair se connecte sans invitation vivante et envoie une enveloppe, ou qu'un pair envoie une enveloppe signée par un autre
- **THEN** rien n'est transmis au moteur et l'envoi échoue chez lui

#### Scenario: AC: échec expliqué
<!-- openspec-guard:test="internet (T4.2b) > explains the failure when no path exists without a relay" -->
- **WHEN** aucun chemin direct n'existe et aucun relais n'est configuré
- **THEN** l'envoi iroh échoue avec `E_IROH_NO_PATH`, la voie suivante est essayée et l'état explique qu'il faut un relais

### Requirement: Adresses iroh partagées entre pairs
Le Node SHALL envoyer à chaque pair, chiffrées, ses adresses iroh au démarrage et à chaque changement, et les mettre dans ses invitations. Il MUST n'accepter que celles d'un pair connu pour lui-même, relais en https (http seulement en boucle locale), 8 adresses directes au plus, gardées en `0600`.

#### Scenario: AC: adresses partagées
<!-- openspec-guard:test="internet (T4.2b) > shares its iroh addresses with each paired peer and keeps only valid ones" -->
- **WHEN** un pair envoie ses adresses, un autre un relais en http public, et qu'une invitation est utilisée
- **THEN** l'adresse valide est gardée, celle en http public refusée, et l'invité connaît les adresses de l'hôte avant tout relais drop

### Requirement: Retour de connexion OAuth sur l'API locale
L'API locale SHALL accepter `GET /oauth/callback?state=…&code=…` sans jeton mais seulement avec son en-tête `Host`, et MUST n'échanger le code que pour une connexion en cours dont le `state`, à usage unique, a moins de 10 min (T2.17, D74). La page de réponse n'autorise aucune ressource. `POST /ui/admin/connect { agent, server }`, derrière le jeton, ouvre la connexion dans le navigateur (macOS, https seulement). Un refus de partage pour OAuth porte `E_SHARE_OAUTH`.

#### Scenario: Retour du navigateur
<!-- openspec-guard:test="remote MCP servers behind OAuth (T2.17) > takes the sign-in callback on the local API without its token, for a pending state only" -->
- **WHEN** le navigateur revient avec un `state` en cours, un `state` inconnu, sans code, avec un refus, ou par un autre hôte
- **THEN** seul le premier échange le code ; les autres reçoivent une page d'erreur ou 401, et `/ui/admin/connect` exige le jeton

### Requirement: Messages d'état fusionnés dans la file d'envoi
Pour un même pair, la file d'envoi SHALL ne garder que le dernier message de chacun des types `lan_key`, `iroh_addr`, `team_roster` et `catalog` : un nouveau remplace l'ancien. Un message plus ancien que le dernier envoyé à ce pair, en file ou déjà livré, MUST ne jamais partir après lui. Les autres messages ne sont jamais fusionnés.

#### Scenario: AC: les annonces n'évincent pas une demande
<!-- openspec-guard:test="outbox coalescing (T4.2e) > keeps one state message per peer and type, so announcements never evict a real request" -->
- **WHEN** un pair absent a une demande en file et que le nœud annonce 1 500 adresses successives et plusieurs clés
- **THEN** la file garde la demande, une seule adresse et une seule clé ; au retour du pair, il reçoit la demande et la dernière adresse

#### Scenario: AC: un ancien message ne part pas après un plus récent livré
<!-- openspec-guard:test="outbox coalescing (T4.2e) > never lets an older queued state message overwrite a newer one already delivered live" -->
- **WHEN** une adresse attend en file, puis une nouvelle adresse est livrée directement au retour du pair
- **THEN** l'ancienne n'est jamais envoyée et le pair garde la nouvelle

#### Scenario: AC: annonces qui se chevauchent
<!-- openspec-guard:test="outbox coalescing (T4.2e) > stops announcing an address once a newer one is being announced" -->
- **WHEN** l'annonce d'une adresse est en cours quand une nouvelle adresse est annoncée
- **THEN** l'ancienne annonce s'arrête et chaque pair finit avec la nouvelle adresse

#### Scenario: AC: un envoi raté ne remplace pas plus récent
<!-- openspec-guard:test="outbox coalescing (T4.2e) > never lets an older state message, re-queued after a failed send, replace a newer one" -->
- **WHEN** une adresse est en cours d'envoi, qu'une nouvelle adresse est mise en file, puis que le premier envoi échoue
- **THEN** seule la nouvelle adresse reste en file

### Requirement: Propriétaire désigné d'une capacité
Le catalogue et `/capabilities` SHALL donner pour chaque entrée l'identifiant de son propriétaire, l'`executorNodeId` vérifié de sa carte. `POST /drops` SHALL accepter `ownerNodeId` ; sans lui, un identifiant publié par plusieurs pairs MUST être refusé avec 409 `E_AMBIGUOUS_CAPABILITY` et la liste des propriétaires, sans rien envoyer. Chaque route d'`ask_team` et de l'A2A entrant MUST viser le propriétaire de l'entrée choisie.

#### Scenario: AC: demande envoyée au propriétaire désigné
<!-- openspec-guard:test="owner targeting (T4.17) > sends a drop to the owner it names and refuses an id that two peers publish" -->
- **WHEN** deux pairs publient le même identifiant et que le demandeur envoie une demande sans propriétaire, puis avec chacun
- **THEN** la première est refusée avec 409 et les deux propriétaires, rien n'est envoyé, et chacune des suivantes part chez le pair nommé

#### Scenario: AC: ask_team vise chaque propriétaire
<!-- openspec-guard:test="owner targeting (T4.17) > routes ask_team to each owner of a capability that two peers share" -->
- **WHEN** deux pairs partagent `mcp.answer.figma` et qu'une question parle d'une maquette
- **THEN** une demande part chez chacun des deux

### Requirement: Politique d'entreprise lue au démarrage
Une politique déposée dans le dossier système, à chemin fixe, avec la clé de son émetteur SHALL être lue au démarrage ; invalide, d'un autre émetteur, expirée, ou un financement hors `allowedProviders`, le daemon MUST refuser de démarrer avec `E_POLICY`.

#### Scenario: AC: politique invalide, démarrage refusé
<!-- openspec-guard:test="enterprise policy (T4.10) > refuses to start on a policy that is tampered with, from another issuer or expired" -->
- **WHEN** la politique déposée est modifiée après signature, signée par un autre émetteur ou expirée
- **THEN** le démarrage échoue avec `E_POLICY`, comme sans `policy.json` à côté de `issuer.pub` ou avec un financement hors liste, et une variable d'environnement ne remplace ni ne déplace une politique système

### Requirement: Politique d'entreprise appliquée au poste
Le Node MUST borner le relais aux `relays`, couper réseau local et iroh si `requireInternalRelay`, n'accepter un relais iroh que sur l'hôte d'un relais listé, refuser les passerelles non permises même liées avant, les clients hors liste et un modèle hors `allowedProviders`, et présenter l'empreinte au relais. À l'expiration, il MUST couper ses voies vers l'équipe. Un appel de modèle MUST ne jamais suivre de redirection.

#### Scenario: AC: politique appliquée
<!-- openspec-guard:test="enterprise policy (T4.10) > applies the policy to the relay, direct paths, gateways, clients and models" -->
- **WHEN** une politique valide exige le relais interne, interdit les passerelles, permet deux clients et un fournisseur
- **THEN** un autre relais est refusé, réseau local et iroh sont coupés, une liaison d'assistant est refusée et une passerelle déjà liée n'est plus entendue, seuls les deux clients sont proposés ou installés (le retrait reste possible), un modèle hors liste est refusé avant tout appel et une redirection n'est pas suivie, l'état affiche la politique ; sans `requireInternalRelay`, un relais iroh tiers est refusé, et à l'expiration le relais est coupé et le mode Internet refusé

### Requirement: Raccordement automatique des treize clients sur trois systèmes
Le Node SHALL raccorder les treize clients sur macOS, Windows et Linux sans copier-coller : Claude Code et Codex par leur commande officielle, relue après coup, les onze autres par leur fichier documenté pour ce système. Chaque écriture MUST suivre les règles de T3.3 : empreinte de l'aperçu relue avant d'écrire, fichier temporaire renommé, sauvegarde privée de trois versions par fichier, entrée identique sans effet, entrée drop différente en conflit, retrait de notre seule entrée.

#### Scenario: AC: raccordement automatique sur macOS
<!-- openspec-guard:test="all thirteen clients connected automatically (T4.22) > connects every file client at its documented macOS path, keeps comments and layout, is idempotent, then removes only its entry" -->
- **WHEN** le propriétaire raccorde les treize clients installés sur un Mac
- **THEN** chacun reçoit l'entrée drop dans sa mise en page à son emplacement macOS, une seconde fois rien ne change, et le retrait rend chaque fichier d'origine

#### Scenario: AC: raccordement automatique sous Windows
<!-- openspec-guard:test="all thirteen clients connected automatically (T4.22) > connects every file client at its documented Windows path, keeps comments and layout, is idempotent, then removes only its entry" -->
- **WHEN** le propriétaire raccorde les treize clients installés sous Windows
- **THEN** chacun est écrit à son emplacement Windows (`%APPDATA%\Claude`, `%APPDATA%\Zed`, `%APPDATA%\Block\goose\config`, `%APPDATA%\Code\User`, `%APPDATA%\devin`…), de façon idempotente, et le retrait rend chaque fichier d'origine

#### Scenario: AC: raccordement automatique sous Linux
<!-- openspec-guard:test="all thirteen clients connected automatically (T4.22) > connects every file client at its documented Linux path, keeps comments and layout, is idempotent, then removes only its entry" -->
- **WHEN** le propriétaire raccorde les clients installés sous Linux
- **THEN** chacun est écrit à son emplacement Linux (`~/.config/…`), de façon idempotente, et le retrait rend chaque fichier d'origine

#### Scenario: AC: fichier absent créé, ajout tiers conservé
<!-- openspec-guard:test="all thirteen clients connected automatically (T4.22) > creates a missing file where each client documents it, and keeps a neighbour added after the connection" -->
- **WHEN** le fichier d'un client est vide, puis un tiers ajoute un serveur après le raccordement
- **THEN** l'entrée drop est créée à la bonne clé, et le retrait garde le serveur du tiers

#### Scenario: AC: fichier modifié ou autre entrée drop
<!-- openspec-guard:test="all thirteen clients connected automatically (T4.22) > refuses a file changed since the preview and a different drop entry, for the new clients too" -->
- **WHEN** le fichier de goose change après l'aperçu, celui de Zed change entre le fichier temporaire et le renommage, et OpenCode porte déjà une autre entrée drop
- **THEN** les trois actions sont refusées (`changed`, `changed`, `conflict`) et chaque fichier garde le contenu du tiers

#### Scenario: AC: commande officielle bornée et relue
<!-- openspec-guard:test="all thirteen clients connected automatically (T4.22) > runs the official command of Codex without blocking the daemon, then verifies what it wrote" -->
- **WHEN** la commande officielle de Codex met du temps à écrire sa configuration
- **THEN** le daemon reste réactif et l'entrée écrite est relue avant d'annoncer le succès

#### Scenario: AC: script de commande sous Windows
<!-- openspec-guard:test="all thirteen clients connected automatically (T4.22) > runs a Windows .cmd shim through cmd.exe only with arguments that are safe inside quotes" -->
- **WHEN** la commande officielle est un script `.cmd` installé par npm sous Windows
- **THEN** elle passe par `cmd.exe` avec chaque argument entre guillemets, et un argument portant `"`, `%`, `!`, `^`, un saut de ligne ou une barre oblique inverse finale est refusé (`E_CLI_SHIM_UNSAFE`)

#### Scenario: AC: Claude Desktop version Store
<!-- openspec-guard:test="all thirteen clients connected automatically (T4.22) > writes the private copy of the Store build of Claude Desktop on Windows when it exists" -->
- **WHEN** la version Store de Claude Desktop a sa copie privée de configuration sous `%LOCALAPPDATA%\Packages`
- **THEN** drop écrit cette copie, que Windows ouvre en premier, et laisse le fichier de `%APPDATA%` intact

### Requirement: Fichier du client gardé tel quel
Une écriture dans le fichier d'un client SHALL ne changer que l'entrée drop : commentaires, ordre des clés, indentation, fins de ligne, BOM et virgules finales MUST rester ; un document relu qui diffère autrement MUST être refusé (`E_CONFIG_EDIT`). Quand les serveurs sont un par ligne, comme les clients les écrivent, le retrait MUST rendre le fichier d'origine à l'octet près. Un fichier invalide MUST être refusé sans écriture.

#### Scenario: AC: JSONC commenté
<!-- openspec-guard:test="format-preserving configuration edits (T4.22) > adds then removes one JSONC entry, keeping comments, trailing commas, order and indentation" -->
- **WHEN** drop ajoute puis retire son entrée dans un fichier JSONC commenté à virgules finales
- **THEN** chaque ligne d'origine reste, l'entrée suit l'indentation du fichier, et le retrait rend le texte d'origine

#### Scenario: AC: BOM, CRLF et tabulations
<!-- openspec-guard:test="format-preserving configuration edits (T4.22) > keeps a BOM, CRLF line endings and tab indentation, and creates a missing file" -->
- **WHEN** le fichier commence par un BOM, finit ses lignes en CRLF et indente par tabulations, ou n'existe pas
- **THEN** BOM, CRLF et tabulations restent, et un fichier absent est créé avec deux espaces et une fin de ligne

#### Scenario: AC: fichier refusé sans écriture
<!-- openspec-guard:test="format-preserving configuration edits (T4.22) > refuses a broken file, comments in strict JSON, or a container that is not an object" -->
- **WHEN** le fichier est tronqué, porte un commentaire alors qu'il est en JSON strict, ou que sa clé de serveurs n'est pas un objet
- **THEN** l'édition est refusée (`E_CONFIG_INVALID`) et rien n'est écrit

#### Scenario: AC: YAML de goose
<!-- openspec-guard:test="format-preserving configuration edits (T4.22) > adds then removes one goose extension, keeping comments and the flush list style goose writes" -->
- **WHEN** drop ajoute puis retire son extension dans un `config.yaml` commenté écrit par goose
- **THEN** chaque ligne d'origine reste, dans le style de listes du fichier, et le retrait rend le texte d'origine

#### Scenario: AC: YAML avec BOM, CRLF et quatre espaces
<!-- openspec-guard:test="format-preserving configuration edits (T4.22) > keeps a YAML BOM, CRLF line endings and four-space indentation, and refuses an edit that would touch anything else" -->
- **WHEN** le `config.yaml` commence par un BOM, finit ses lignes en CRLF et indente de quatre espaces, ou que l'entrée à retirer n'existe pas
- **THEN** BOM, CRLF et indentation restent, le retrait rend le texte d'origine, et retirer une entrée absente ne change rien

### Requirement: Secours expliqué quand l'écriture est impossible
Le Node SHALL proposer la configuration à coller, ou la commande à lancer, seulement quand il ne peut pas écrire : fichier illisible, invalide, verrouillé, trop gros ou lien vers un autre fichier, emplacement non documenté sur ce système, commande officielle absente ou arguments non sûrs pour `cmd.exe`. Le secours MUST dire la raison, quoi coller et où, et MUST NOT écrire ni préparer quoi que ce soit pour ce client.

#### Scenario: AC: secours seulement si l'écriture est impossible
<!-- openspec-guard:test="all thirteen clients connected automatically (T4.22) > falls back to an explained configuration only when a write is impossible" -->
- **WHEN** sous Linux, la configuration de Zed est invalide, Claude Desktop (bêta, emplacement non documenté) est installé et Codex n'a pas de commande exécutable
- **THEN** ces trois reçoivent leur secours avec la raison (`E_CONFIG_INVALID_OR_UNREADABLE`, `E_CONFIG_UNDOCUMENTED`, `E_CLI_MISSING`), le fichier invalide reste intact, et tous les autres clients installés sont prêts sans copier-coller

#### Scenario: AC: conflit plutôt que secours
<!-- openspec-guard:test="all thirteen clients connected automatically (T4.22) > reports a drop entry in a Claude Code project as a conflict, never as something to paste" -->
- **WHEN** Claude Code déclare déjà une entrée drop dans l'un de ses projets
- **THEN** l'état est `conflict` (`E_SCOPE_CONFLICT`), sans configuration à coller

#### Scenario: AC: commande de secours prête à coller
<!-- openspec-guard:test="all thirteen clients connected automatically (T4.22) > prints a fallback command quoted for the shell of the owner, Windows paths unchanged" -->
- **WHEN** la commande officielle de Codex manque sous Windows, avec des chemins à espaces
- **THEN** la commande donnée est citée pour PowerShell, sans doubler une barre oblique inverse, et pour un shell POSIX entre apostrophes

#### Scenario: AC: cas limites sans écriture fautive
<!-- openspec-guard:test="all thirteen clients connected automatically (T4.22) > keeps edge cases out: a stable OpenCode server named servers, an older Devin entry, a linked file, script extensions" -->
- **WHEN** un serveur OpenCode 1 s'appelle `servers`, l'ancien fichier de Devin porte déjà une entrée drop, la configuration de Zed est un lien, et `PATHEXT` liste des scripts
- **THEN** drop écrit sous `mcp` et non dans ce serveur, Devin est en conflit, le lien n'est pas suivi (`E_CONFIG_SYMLINK` avec sa raison), et seuls `.exe`, `.com`, `.cmd` et `.bat` comptent comme exécutables

#### Scenario: AC: rien de préparé pour un client non écrit
<!-- openspec-guard:test="all thirteen clients connected automatically (T4.22) > keeps the requester server out of a client drop could not write" -->
- **WHEN** une sélection forgée vise un client dont le fichier est illisible
- **THEN** l'action échoue et le serveur demandeur n'est même pas copié

### Requirement: Lien d'invitation à envoyer
L'API locale SHALL répondre à `POST /ui/invite` par `{ code, link, validHours: 24 }`, où `link` est le lien de la page pour rejoindre avec le code dans le fragment. Les invitations du Node SHALL nommer le relais qu'il utilise au moment de l'invitation.

#### Scenario: AC: lien produit par l'app
<!-- openspec-guard:test="one-link join (T4.23) > a fresh private node adopts the relay of the link, is admitted and joins the team after Rejoindre" -->
- **WHEN** l'inviteur demande une invitation à son Node
- **THEN** il reçoit `https://drop.memolabs.dev/join#<code>`, et une fois l'invitée arrivée dans l'équipe, les invitations de celle-ci nomment le relais de l'équipe

### Requirement: Rejoindre par un lien
`POST /ui/pair/preview` SHALL vérifier une invitation, code ou lien, sans rien envoyer. `POST /ui/pair`, après « Rejoindre », SHALL refaire ces vérifications, appairer et répondre `next: 'connect_agents'`. Chaque refus MUST répondre 400 avec son code stable (`E_INVITE`, `E_INVITE_EXPIRED`, `E_INVITE_SIG`, `E_INVITE_USED`, `E_INVITE_RELAY`) sans répéter l'invitation, qui MUST NOT apparaître dans un journal. Le Node MUST refuser sa propre invitation.

#### Scenario: AC: refus à codes stables
<!-- openspec-guard:test="one-link join (T4.23) > answers each refusal with its stable code: modified, expired, own, reused, unreadable" -->
- **WHEN** l'invitée présente une invitation modifiée, expirée, la sienne, un lien d'une autre sorte, puis une invitation déjà acceptée
- **THEN** elle reçoit `E_INVITE_SIG`, `E_INVITE_EXPIRED`, `E_INVITE`, `E_INVITE` puis `E_INVITE_USED`, sans écho du code, et rien n'est envoyé

### Requirement: Relais adopté au premier « Rejoindre »
Un Node sur le relais de bouclage par défaut (`DEFAULT_RELAY_URL`, `ws://127.0.0.1:7780/v1`), sans pair, équipe ni appairage en cours SHALL, après « Rejoindre », passer au relais de l'invitation : `config.json` réécrit sous verrou, connexion changée sans redémarrage, puis admission et appairage. La prévisualisation MUST ne rien changer. Un relais non admissible ou hors politique MUST être refusé (`E_INVITE_RELAY`). Un Node déjà relié ou réglé à la main SHALL garder son relais (`kept`).

#### Scenario: AC: deux « Rejoindre » rapides et appairage en cours
<!-- openspec-guard:test="one-link join (T4.23) > accepts a link once even on two quick « Rejoindre », and moves no relay while a pairing is pending" -->
- **WHEN** l'invitée appuie deux fois sur « Rejoindre » avec le même lien, puis accepte un second lien avant la réponse du premier inviteur
- **THEN** le second appui est refusé avec `E_INVITE_USED` et une seule demande d'appairage part, et le second lien garde le relais déjà adopté (`kept`)

#### Scenario: AC: carte qui annonce le relais
<!-- openspec-guard:test="menu bar panel and its admin routes (T4.14) > names the relay only when Rejoindre would move to it, and shows each refusal with the message of its stable code" -->
- **WHEN** le panneau montre la carte d'une invitation qui ferait changer de relais, ou qu'un lien est refusé
- **THEN** la carte nomme le relais de l'invitation avant « Rejoindre », et le refus affiche le message de son code stable

#### Scenario: AC: nouveau poste sur le relais de l'équipe
<!-- openspec-guard:test="one-link join (T4.23) > a fresh private node adopts the relay of the link, is admitted and joins the team after Rejoindre" -->
- **WHEN** un poste privé neuf, sur le relais de bouclage par défaut, prévisualise puis accepte le lien d'un membre admis du relais de l'équipe
- **THEN** la prévisualisation annonce `adopt` sans rien changer, puis le poste passe au relais de l'équipe, y est admis par le ticket, rejoint l'équipe, et ses destinations privées restent celles d'avant, sans le relais adopté

#### Scenario: AC: relais gardé ou refusé
<!-- openspec-guard:test="one-link join (T4.23) > keeps the relay of a node that already joined someone, and refuses a relay it may not adopt (E_INVITE_RELAY)" -->
- **WHEN** l'invitation nomme `ws://` vers un nom DNS ou une adresse publique littérale, puis, le poste ayant une équipe, un autre relais admissible
- **THEN** les premières sont refusées avec `E_INVITE_RELAY` sans modifier `config.json` ni appairer, la dernière garde le relais du poste (`kept`)

#### Scenario: AC: relais réglé à la main gardé
<!-- openspec-guard:test="join hardening (T4.33) > adopts a relay only from the default loopback relay: a relay set by hand is kept" -->
- **WHEN** un poste neuf, sans pair ni équipe, réglé à la main sur un relais interne, accepte une invitation qui nomme un autre relais
- **THEN** la prévisualisation et « Rejoindre » rendent `kept`, `config.json` ne change pas et la demande d'appairage part

### Requirement: Invitations gardées au redémarrage
Le Node SHALL garder dans `invites.json` (mode `0600`) les jetons de ses invitations encore valables, pour les honorer une seule fois après un redémarrage, et l'empreinte SHA-256 des invitations qu'il a acceptées, jamais leur jeton, pour refuser une seconde utilisation (`E_INVITE_USED`). Les deux s'effacent à l'expiration de l'invitation.

#### Scenario: AC: lien honoré après redémarrage, une fois
<!-- openspec-guard:test="one-link join (T4.23) > the inviter honours a link sent before its restart, once, and forgets it when it expires" -->
- **WHEN** l'inviteur redémarre puis reçoit deux demandes avec le même jeton, puis une demande avec un jeton expiré
- **THEN** seule la première aboutit

#### Scenario: AC: lien déjà accepté refusé après redémarrage
<!-- openspec-guard:test="one-link join (T4.23) > remembers accepted invites across a restart: a reused link stays refused (E_INVITE_USED)" -->
- **WHEN** l'invitée accepte un lien, redémarre, puis le présente de nouveau
- **THEN** il est refusé avec `E_INVITE_USED`, rien n'est envoyé, et `invites.json` ne contient pas le jeton

### Requirement: Profil par défaut privé
Le schéma de configuration MUST lire un `config.json` sans `profile` comme le profil privé que crée `drop init`, soumis aux mêmes contrôles. Un fichier `legacy` MUST porter `profile: 'legacy'`. `drop migrate-private` SHALL encore lire un fichier antérieur aux profils comme `legacy`.

#### Scenario: AC: fichier sans profil
<!-- openspec-guard:test="configuration hygiene (T4.15) > reads a configuration without a profile as the private profile drop init creates" -->
- **WHEN** une config ne porte pas de `profile`
- **THEN** elle est lue comme privée, refusée si elle n'en remplit pas les conditions, et une config `legacy` explicite reste acceptée

#### Scenario: AC: migration d'un fichier antérieur aux profils
<!-- openspec-guard:test="configuration hygiene (T4.15) > still migrates a pre-profile legacy configuration to the private profile" -->
- **WHEN** `drop migrate-private` lit un `config.json` écrit avant les profils
- **THEN** il le traite comme `legacy` et écrit une config privée payée par le propriétaire

### Requirement: Pairs et équipe en mode 0600
`peers.json` et `team.json` MUST être en mode `0600`. Une écriture MUST resserrer un fichier existant avant d'y poser le nouveau contenu, et le daemon MUST resserrer au démarrage ceux qu'une version antérieure a laissés plus ouverts.

#### Scenario: AC: fichiers des pairs et de l'équipe privés
<!-- openspec-guard:test="configuration hygiene (T4.15) > keeps peers.json and team.json owner-only, narrowing existing files" -->
- **WHEN** le Node crée ou réécrit `peers.json` ou `team.json`, y compris un fichier existant en `0644`, ou démarre avec un tel fichier
- **THEN** le fichier est en `0600` sous macOS et Linux, son contenu inchangé tant que rien n'y est écrit

### Requirement: Agents détectés nommables par le protocole
La liste des agents que le Node détecte et raccorde MUST être exactement celle que `requestedBy.agent` peut nommer, `other` excepté.

#### Scenario: AC: listes alignées
<!-- openspec-guard:test="configuration hygiene (T4.15) > detects exactly the agents the protocol can name on a consent card" -->
- **WHEN** on compare les agents détectés aux agents du protocole
- **THEN** les deux listes sont identiques, `other` excepté

### Requirement: Relais adopté hors des destinations
Le relais adopté d'une invitation MUST NOT entrer dans `network.origins`, et l'adoption MUST NOT en retirer aucune origine : le relais est choisi par l'inviteur, il ne devient pas une destination du modèle ou des serveurs MCP (T4.33). `config.json` SHALL alors porter `relayAdopted: true`, qui dispense ce relais seul d'être une origine listée.

#### Scenario: AC: origines du propriétaire conservées
<!-- openspec-guard:test="join hardening (T4.33) > switching relay keeps every listed origin and never lists the adopted relay" -->
- **WHEN** un profil privé dont le propriétaire a listé l'origine du relais par défaut et une origine interne adopte un relais à adresse privée littérale, puis redémarre
- **THEN** `network.origins` est inchangé, ne contient pas le relais adopté, `relayAdopted` vaut `true` et la configuration se relit sans erreur

### Requirement: Vraie cause d'un échec d'adoption
Quand `config.json` ne peut être réécrit pour adopter un relais, le refus de « Rejoindre » MUST porter sa cause : `E_LOCKED` quand le verrou de configuration est occupé, `E_CONFLICT` quand le fichier a changé entre sa lecture et sa réécriture, au lieu de `E_INVITE_RELAY`. L'API MUST répondre 400 avec ce code et son message, sans écho de l'invitation, et l'invitation MUST rester utilisable (T4.33).

#### Scenario: AC: vraie cause d'un échec de réécriture
<!-- openspec-guard:test="join hardening (T4.33) > answers E_LOCKED or E_CONFLICT, not E_INVITE_RELAY, when config.json cannot be rewritten, and keeps the invite usable" -->
- **WHEN** « Rejoindre » trouve le verrou de configuration occupé, ou la réécriture de `config.json` échoue en `E_CONFLICT`
- **THEN** l'API répond 400 `E_LOCKED` avec son message, le moteur refuse avec `E_CONFLICT`, rien n'est envoyé, et le même lien est accepté une fois la cause levée

### Requirement: Publication nommée par un identifiant de capacité
`DropHome.publish` SHALL refuser, avec `E_CAPABILITY_ID` et sans rien écrire, un identifiant qui n'est pas un identifiant de capacité (`CapabilityIdSchema`). Le nom du fichier de publication MUST NOT sortir de `DROP_HOME/capabilities`, quel que soit l'appelant (`drop publish`, `drop share --id`, le panneau).

#### Scenario: AC: identifiant qui serait un chemin refusé
<!-- openspec-guard:test="security alerts triage (T4.26) > publishes under a capability id only, never under a path that leaves DROP_HOME" -->
- **WHEN** une publication porte l'identifiant `../../escaped`, `mcp.answer.../../../escaped`, `Upper.case` ou une chaîne vide
- **THEN** elle est refusée avec `E_CAPABILITY_ID`, aucun fichier n'apparaît hors de `DROP_HOME`, et `mcp.answer.figma` reste publiable

### Requirement: Configurations des clients lues sans blocage
La lecture des configurations des clients (JSON, JSONC, TOML de Codex, YAML de goose) SHALL prendre un temps linéaire dans la taille du fichier, quelle que soit la ligne qu'il contient, et donner les mêmes valeurs qu'avant T4.26 sur une configuration bien formée. Un fichier de configuration SHALL être ouvert une fois, puis contrôlé (type, taille) et lu par ce même descripteur ; un tube nommé, un dossier ou un fichier trop gros MUST être refusé sans attendre.

#### Scenario: AC: TOML de Codex en temps linéaire
<!-- openspec-guard:test="configuration and reply parsing in linear time (T4.26) > reads Codex TOML arrays, inline tables and pairs as before, in linear time on hostile lines" -->
- **WHEN** une configuration Codex porte une ligne de 100 000 caractères en forme de piège (chaîne non fermée répétée, clé sans fin, espaces sans valeur)
- **THEN** elle est lue en moins de 1,5 s, et les tableaux, tables en ligne et paires bien formés donnent les mêmes valeurs qu'avant

#### Scenario: AC: YAML de goose en temps linéaire
<!-- openspec-guard:test="configuration and reply parsing in linear time (T4.26) > reads goose extensions as before, in linear time on hostile lines" -->
- **WHEN** une extension goose porte une valeur de 100 000 espaces sans commentaire, ou des ` #` répétés
- **THEN** elle est lue en moins de 1,5 s, et une extension bien formée donne les mêmes valeurs qu'avant

#### Scenario: AC: fichier contrôlé par le descripteur lu
<!-- openspec-guard:test="configuration files read through one descriptor (T4.26) > reads a regular file, refuses a directory or an oversized file, and never waits on a named pipe" -->
- **WHEN** le chemin d'une configuration désigne un fichier, un fichier absent, un dossier, un fichier plus gros que la borne ou un tube nommé
- **THEN** le fichier est lu, l'absent donne `undefined`, le dossier et le tube sont refusés à l'instant avec `E_CONFIG_TYPE`, le fichier trop gros avec `E_CONFIG_TOO_LARGE`

### Requirement: Raccourci Windows lancé sans interprétation des métacaractères
La ligne `cmd.exe` d'un raccourci `.cmd` SHALL garder chaque argument entre une seule paire de guillemets, de sorte que `&`, `|`, `<`, `>`, les parenthèses et les espaces d'un chemin restent littéraux pour `cmd.exe` et pour le `%*` du raccourci. Le programme lancé SHALL être `cmd.exe`, jamais la variable `ComSpec`.

#### Scenario: AC: métacaractères d'un chemin gardés entre guillemets
<!-- openspec-guard:test="security alerts triage (T4.26) > keeps cmd.exe metacharacters of a Windows shim path inside quotes, and never runs ComSpec" -->
- **WHEN** le raccourci vit sous `C:\Users\a&b|c\npm (x86)\` et `ComSpec` désigne un autre programme
- **THEN** la commande lance `cmd.exe` avec chaque argument entre guillemets, et un chemin portant `"`, `%` ou un saut de ligne est refusé (`E_CLI_SHIM_UNSAFE`)

### Requirement: Part de chaque pair dans le stockage anti-rejeu
Le Node MUST refuser avec `E_RATE`, avant tout accord, la demande d'un pair qui tient déjà 1 024 identifiants vivants, tandis que les autres pairs restent admis. Le compte MUST survivre au redémarrage et ne nomme pas le pair (étiquette hachée). Les identifiants migrés sans émetteur ne comptent que dans le plafond global. Le journal du Node porte `replay_peer_quota`, ou `replay_capacity` pour la saturation globale.

#### Scenario: AC: part d'un pair épuisée
<!-- openspec-guard:test="replay store per-peer share (T3.1e) > refuses a peer holding its share of live ids while other peers are still admitted" -->
- **WHEN** un pair tient 1 024 identifiants vivants
- **THEN** sa demande suivante est refusée, y compris après redémarrage, un autre pair est admis, et le premier l'est de nouveau quand ses identifiants expirent

#### Scenario: AC: identifiants migrés sans émetteur
<!-- openspec-guard:test="replay store per-peer share (T3.1e) > counts ids migrated without a sender only against the global cap" -->
- **WHEN** plus de 1 024 identifiants migrés sans émetteur sont vivants
- **THEN** un pair reste admis tant que le plafond global n'est pas atteint

#### Scenario: AC: refus par pair à travers le moteur
<!-- openspec-guard:test="replay admission through the engine > refuses a peer holding its replay share with E_RATE before consent, while another peer is admitted" -->
- **WHEN** le pair qui tient sa part envoie une demande, puis un autre pair en envoie une
- **THEN** le premier reçoit `E_RATE` sans carte d'accord et le journal porte `replay_peer_quota`, le second obtient une carte d'accord

### Requirement: Coût et durabilité d'une admission
Une admission MUST coûter une seule synchronisation, celle du journal où son enregistrement est ajouté, sans renommage, lecture ni synchronisation de dossier, quel que soit le nombre d'identifiants vivants. Elle ne retourne qu'après cette synchronisation, de sorte qu'une coupure de courant ne puisse défaire une admission annoncée, y compris sous Windows.

#### Scenario: AC: une synchronisation par admission
<!-- openspec-guard:test="replay clock write failures > admits with a single flush of the journal, without renaming, listing or flushing a folder" -->
- **WHEN** le Node admet des demandes alors que 16 000 identifiants sont vivants
- **THEN** chaque admission fait exactement une synchronisation de fichier, aucune de dossier, aucun renommage et aucune lecture de dossier

#### Scenario: AC: dossier vidé seulement hors de Windows
<!-- openspec-guard:test="directory flush of the private stores (T3.1e) > flushes a directory on macOS and Linux, and skips only that call on Windows, which cannot flush one" -->
- **WHEN** la création des journaux doit être rendue durable
- **THEN** le dossier est vidé sous macOS et Linux, et seul cet appel est sauté sous Windows

### Requirement: Index anti-rejeu partagé entre processus
Sous le verrou, les en-têtes et la taille des deux journaux MUST prouver que l'index en mémoire est à jour, sinon il est relu. La compaction réécrit l'autre journal avec la génération suivante puis vide l'ancien, de sorte qu'un seul journal soit valide.

#### Scenario: AC: deux processus sur le même stockage
<!-- openspec-guard:test="replay store journal (T3.1e) > sees the admissions and compactions of another process sharing the home" -->
- **WHEN** deux processus admettent tour à tour sur le même `DROP_HOME` et que l'un compacte le journal
- **THEN** chacun refuse les identifiants admis par l'autre et l'autre ajoute ensuite au nouveau journal, jamais à l'ancien

### Requirement: Reprise après crash
Un crash à n'importe quel point d'une admission MUST laisser un stockage que le redémarrage reprend sans intervention : tout identifiant admis avant reste refusé, l'identifiant interrompu est admis au plus une fois, et un enregistrement final incomplet, jamais annoncé, est coupé.

#### Scenario: AC: crash pendant une admission ordinaire
<!-- openspec-guard:test="replay store crash points > recovers from a crash at any point of an ordinary claim" -->
- **WHEN** le processus s'arrête à n'importe quel appel du système de fichiers d'une admission, une écriture pouvant rester à moitié faite
- **THEN** au redémarrage les identifiants admis avant sont refusés, l'identifiant interrompu est admis au plus une fois et une autre demande est admise

#### Scenario: AC: crash pendant une compaction
<!-- openspec-guard:test="replay store crash points > recovers from a crash at any point of a claim that compacts the journal" -->
- **WHEN** le processus s'arrête à n'importe quel point d'une admission qui compacte le journal
- **THEN** le même résultat tient, sans quarantaine

#### Scenario: AC: crash pendant la première admission
<!-- openspec-guard:test="replay store crash points > recovers from a crash at any point of the first claim on a fresh home" -->
- **WHEN** le processus s'arrête à n'importe quel point de la première admission d'un `DROP_HOME` neuf
- **THEN** la création reprend au redémarrage

#### Scenario: AC: crash pendant la migration
<!-- openspec-guard:test="replay store crash points > recovers from a crash at any point of the upgrade of a format-2 store" -->
- **WHEN** le processus s'arrête à n'importe quel point de la migration d'un stockage de format 2
- **THEN** la migration reprend et l'identifiant migré reste refusé

#### Scenario: AC: crash pendant la reprise après quarantaine
<!-- openspec-guard:test="replay store crash points > recovers from a crash at any point of the restart after a quarantine" -->
- **WHEN** le processus s'arrête à n'importe quel point de la première admission qui suit une quarantaine
- **THEN** la reprise recommence et l'identifiant de l'état perdu reste refusé comme périmé

#### Scenario: AC: enregistrement final incomplet
<!-- openspec-guard:test="replay store journal (T3.1e) > cuts a torn last record, which no admission returned for, and keeps admitting" -->
- **WHEN** le journal se termine par un enregistrement partiel ou nul
- **THEN** il est coupé, les identifiants admis restent refusés et l'admission continue

### Requirement: Reprise d'un verrou abandonné
Le Node MUST reprendre un verrou dont le propriétaire est prouvé mort (même poste, même démarrage et, sous Linux, même espace de PID, processus disparu), à travers une garde nommée d'après ce propriétaire. Il MUST laisser en place tout autre verrou.

#### Scenario: AC: verrou d'un processus mort
<!-- openspec-guard:test="bounded received drops > takes over a lock whose owner is provably dead, through a guard a live taker keeps" -->
- **WHEN** le propriétaire du verrou est un processus disparu de ce poste et de ce démarrage
- **THEN** le Node le reprend, sauf tant qu'un processus vivant tient la garde de cette reprise ; une garde laissée par un preneur mort est reprise de la même façon

### Requirement: Quarantaine après perte d'état
Une perte ou une incohérence de l'état anti-rejeu MUST ouvrir une quarantaine durable : toute admission est refusée jusqu'à la plus haute horloge connue plus 35 minutes, même si l'horloge recule. Le stockage repart ensuite avec une horloge au moins égale à cette fin, de sorte que tout identifiant antérieur reste refusé comme périmé.

#### Scenario: AC: fin de quarantaine
<!-- openspec-guard:test="replay store journal (T3.1e) > quarantines a journal damaged before its last record, then admits again past every id it held" -->
- **WHEN** la quarantaine ouverte par un journal endommagé arrive à son terme
- **THEN** une nouvelle demande est admise et les identifiants de l'état perdu sont refusés comme périmés, l'horloge du journal valant la fin de la quarantaine
