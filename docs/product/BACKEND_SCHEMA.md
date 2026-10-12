# Schéma backend de drop

Document descriptif. Les contrats normatifs vivent dans openspec/specs ; l'ordre dans docs/TASKS.md ; les décisions dans docs/DECISIONS.md.

Rédigé le 10 octobre 2026 dans la change `t4-0-product-docs` (T4.0). Compagnon du [TRD](TRD.md).

## Comment lire

Ce document cartographie les données : identités, messages, stockage, reçus, contrats. Il résume chaque schéma zod et renvoie à son fichier et à sa ligne ; il ne les recopie pas. Les schémas zod sont la source de vérité des messages et des capacités ([AGENTS.md](../../AGENTS.md#stack-imposée)) ; les exigences se lisent dans les specs liées.

| Marqueur      | Sens                                 | Preuve exigée                                                   |
| ------------- | ------------------------------------ | --------------------------------------------------------------- |
| **Existant**  | Présent dans le code de ce dépôt.    | `fichier:ligne`, nom de test ou preuve archivée.                |
| **Visé**      | Cible adoptée, pas encore livrée.    | Tâche T3.\* ou T4.\* de [l'index][tasks].                       |
| **Hypothèse** | Supposé, non vérifié.                | Critère qui la confirme ou l'invalide.                          |

Les sections « Identités » à « Correspondance A2A » sont **Existant** ligne par ligne. La dernière section ne contient que des **propositions non normatives**, chacune rattachée à la tâche qui la spécifiera.

## Identités et clés

Contrat : [spec protocol](../../openspec/specs/protocol/spec.md#requirement-paire-de-clés-ed25519) et [spec node](../../openspec/specs/node/spec.md#requirement-contenu-de-drop_home).

| Élément                | Format                                                                                       | Stockage                                                     | Source                                                     |
| ---------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------- |
| `NodeId`               | Clé publique Ed25519 de 32 octets en base64url, 43 caractères.                                | Dans l'identité, les pairs, les reçus.                       | **Existant** : `packages/protocol/src/identity.ts:6`       |
| `Identity`             | `nodeId`, `publicKey`, `secretKey` (base64url), `createdAt`, `displayName` (1 à 80).          | `DROP_HOME/identity.json`, mode 0600.                        | **Existant** : `identity.ts:12-18`, `packages/node/src/home.ts:214` |
| Clés X25519            | Dérivées de l'identité Ed25519 à chaque usage, jamais écrites.                               | Mémoire.                                                     | **Existant** : `identity.ts:50-61`                         |
| `OwnerKind`            | `human`, `team`, `machine`, `service` (D8).                                                  | Config, pairs, membres d'équipe.                             | **Existant** : `identity.ts:9`                             |
| Jeton local            | 32 octets aléatoires en base64url ; refus de démarrer s'il est vide.                         | `DROP_HOME/local-token`, mode 0600.                          | **Existant** : `home.ts:217`, `:351-360`                   |
| Invitation             | JSON en base64url : `relayUrl`, `nodeId`, `displayName`, `oneTimeToken`, `expiresAt` (24 h), `admission?`, `team?`. | Transmise hors bande, jamais écrite par le Node.  | **Existant** : `packages/protocol/src/invite.ts:11-21`, `:42-55` |
| Ticket d'admission     | `v`, `sponsor`, `nonce`, `expiresAt` (24 h), `sig` du parrain.                               | `DROP_HOME/admission.json` (0600) jusqu'à l'admission.       | **Existant** : `packages/protocol/src/admission.ts:15-21`, `home.ts:343-349` |
| Équipe                 | `teamId` (16 à 43 caractères), `name` ; membres avec `nodeId`, `displayName`, `ownerKind`, `agents` (8 au plus). | `DROP_HOME/team.json`.                  | **Existant** : `packages/protocol/src/team.ts:10-22`, `home.ts:95`, `:381-388` |
| Identité de passerelle | Même format que `Identity`.                                                                   | `GATEWAY_HOME/identity.json`, hors profil privé.            | **Existant** : `packages/gateway/src/cli.ts:15-19`         |

**Existant** : le relais n'a pas d'identité propre ; il vérifie des signatures sans en produire (`packages/relay/src/server.ts:243`).

## Messages du protocole

Union discriminée sur `type`, 17 variantes (`packages/protocol/src/messages.ts:69-148`). Contrat : [spec protocol](../../openspec/specs/protocol/spec.md#requirement-union-discriminée-des-messages). Tout le tableau est **Existant**.

| `type`              | Champs clés                                                                                                   | Défini à                | Sens                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------- | --------------------------------------------------------- |
| `pair_request`      | `oneTimeToken` (16 et plus), `displayName`, `ownerKind`                                                        | `messages.ts:70-75`     | Le nouveau venu présente le jeton de l'invitation.        |
| `pair_accept`       | mêmes champs                                                                                                   | `messages.ts:76-81`     | L'invitant confirme l'appairage.                          |
| `team_roster`       | `team`, `members` (200 au plus)                                                                                | `messages.ts:82-86`     | Diffusion de la liste d'équipe (T2.9).                    |
| `link_grant`        | `sessionId`, `clientName`                                                                                      | `messages.ts:88-92`     | Liaison d'un assistant via la passerelle (D31).           |
| `agent_call`        | `callId`, `tool` (`ask_team`, `get_drop_results`, `list_capabilities`), `args`                                 | `messages.ts:93-98`     | Appel relayé par la passerelle vers le Node.              |
| `agent_reply`       | `callId`, `text` (60 000 au plus), `isError`                                                                   | `messages.ts:99-104`    | Réponse du Node à la passerelle.                          |
| `catalog_request`   | aucun                                                                                                          | `messages.ts:105`       | Demande du catalogue d'un pair.                           |
| `catalog`           | `cards` : cartes signées                                                                                       | `messages.ts:106`       | Catalogue des capacités publiées.                         |
| `drop_request`      | `dropId` UUIDv7 normalisé en minuscules, `capabilityId`, `capabilityVersion`, `input`, `purpose` (140), `requestedBy`, `funding?` | `messages.ts:107-116` | Demande d'exécution d'une capacité.            |
| `drop_status`       | `dropId`, `state`                                                                                              | `messages.ts:117`       | Avancement vu par le demandeur.                           |
| `approval_request`  | `dropId`, `card`, `inputPreview` (2 000), `purpose`, `requestedBy`, `expiresAt`                                | `messages.ts:118-126`   | Carte de consentement envoyée à l'approbateur.            |
| `approval_decision` | `dropId`, `decision` (`allow_once`, `deny`, `not_now`), `decidedAt`                                            | `messages.ts:127-132`   | Décision signée de l'approbateur.                         |
| `review_request`    | `dropId`, `output`, `expiresAt`                                                                                | `messages.ts:133`       | Relecture avant envoi en sensibilité `high`.              |
| `review_decision`   | `dropId`, `decision` (`send`, `discard`), `redactions?`                                                        | `messages.ts:134-139`   | Décision de relecture.                                    |
| `drop_result`       | `dropId`, `output`, `outputSchemaHash`                                                                         | `messages.ts:140`       | Résultat validé.                                          |
| `drop_error`        | `dropId`, `code` (9 codes), `message` (300)                                                                    | `messages.ts:141-146`   | Refus, expiration ou échec.                               |
| `receipt`           | `receipt`                                                                                                      | `messages.ts:147`       | Reçu signé par l'exécuteur.                               |

Sous-schémas, tous **Existant** :

- `RequestedBy` (`messages.ts:13-17`) : `nodeId`, `displayName`, `agent` parmi `claude_code`, `codex`, `cursor`, `other`.
- `ConsentCost` (`messages.ts:21-25`) : `free`, `capped` avec `maxUsd`, ou `unmeasured`.
- `Funding` (`messages.ts:32-38`) : clé plafonnée du demandeur (D27), `maxUsd` de 50 au plus ; refusée en profil privé (`packages/node/src/engine.ts:781-789`).
- `ConsentCard` (`messages.ts:42-52`) : `capabilityId`, `title`, `receives`, `neverReceives`, `sensitivity`, `executorName`, `cost?`, `paidBy?`.
- Codes de `drop_error` (`messages.ts:56-66`) : `E_SCHEMA`, `E_DENIED`, `E_NOT_NOW`, `E_EXPIRED`, `E_RATE`, `E_BUDGET`, `E_OUTPUT_INVALID`, `E_SECRET_DETECTED`, `E_RUNNER`.
- Codes partagés (`packages/protocol/src/errors.ts:2-19`) : 16 codes, dont les contrôles d'enveloppe et `E_INVITE`.
- États du Drop (`packages/protocol/src/lifecycle.ts:3-15`) et transitions (`:19-31`) : `in_review` seulement en sensibilité `high` (D17).

## Enveloppe et chiffrement

Contrat : [spec protocol](../../openspec/specs/protocol/spec.md#requirement-champs-de-lenveloppe). Tout est **Existant**.

- `Envelope` (`packages/protocol/src/envelope.ts:22-32`) : `v` = 1, `id` (UUIDv7 généré à l'envoi), `from`, `to`, `ts`, `exp`, `nonce` (24 octets en base64url), `body` (texte chiffré en base64url), `sig`.
- Bornes (`envelope.ts:17-20`) : 256 Kio par enveloppe, TTL de 15 minutes, décalage d'horloge de 5 minutes, fenêtre de rejeu de 30 minutes.
- Chiffrement (`envelope.ts:61-66`) : `crypto_box_easy` de la forme canonique du message validé, clé X25519 de l'expéditeur et du destinataire.
- Signature (`envelope.ts:35-38`, `:77`) : Ed25519 sur la forme canonique de tous les champs sauf `sig` ; forme canonique dans `packages/protocol/src/canonical.ts:5-26`.
- Ouverture (`envelope.ts:126-178`) : `E_SCHEMA`, `E_SIG`, `E_UNKNOWN_PEER`, `E_EXPIRED`, `E_REPLAY`, `E_DECRYPT`, `E_MESSAGE_SCHEMA`, dans cet ordre ; test « every error code in the specified order ».
- Trames du relais (`packages/relay/src/wire.ts:5-22`) : serveur `challenge`, `ready`, `envelope`, `ack` (`delivered` ou `queued`), `error` (`E_SCHEMA`, `E_TOO_LARGE`, `E_RATE`, `E_QUEUE_FULL`) ; client `auth` (`nodeId`, `sig`, `admission?`) et `envelope`. Fermetures 4401, 4403, 4409 (`wire.ts:24-26`).
- Politique réseau privée (`packages/protocol/src/private-network.ts:32-46`) : 1 à 100 origines canoniques sur IP privées littérales.

## Relais : état et persistance

Contrat : [spec relay](../../openspec/specs/relay/spec.md#requirement-aucun-stockage-hors-de-la-file).

| Donnée                  | Contenu                                                                                                                      | Persistance                                  | Source                                                     |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------- |
| Config                  | `port`, `host`, `allowedNodeIds`, `revokedNodeIds`, `maxQueuePerNode` (100), `rateLimitPerMinute` (60), `admittedPath?`, `maxAdmissionsPerSponsorPerDay` (20) | `relay.config.json` ; mode 0600 seulement à la création du fichier par la révocation, et aucun mode imposé par `allowNode` (**Visé** T4.15). | **Existant** : `packages/relay/src/server.ts:25-35`, `packages/relay/src/config.ts:17-25` |
| Admissions              | `admitted` (`nodeId`, `sponsor`, `at`) et `spentNonces` (`nonce`, `expiresAt`)                                              | `admitted.json`, mode 0600.                  | **Existant** : `server.ts:79-88`, `:127`                   |
| Files                   | Enveloppes opaques par destinataire, purgées à `exp`                                                                         | Mémoire, perdues au redémarrage.             | **Existant** : `server.ts:134`, `:147-151`                 |
| Connexions et débit     | Socket par `nodeId`, horodatages d'envoi sur une minute                                                                      | Mémoire.                                     | **Existant** : `server.ts:132-133`, `:153-168`             |
| Journal                 | `event`, `outcome`, `nodeId?`, `id?`, `from?`, `to?`, `size?`, `sponsor?`                                                    | Sortie standard.                             | **Existant** : `server.ts:38-48`, `:74-76`                 |

- **Existant** : le relais voit `id`, `from`, `to`, `ts`, `exp` et la taille ; il ne voit jamais le type de message ni le contenu, car le corps est chiffré (`wire.ts:4`, `packages/protocol/src/envelope.ts:61-66`).
- **Existant** : le journal ne contient pas d'adresse IP (`server.ts:38-48`) ; la couche réseau la connaît néanmoins.
- **Existant** : `GET /health` renvoie le nombre de Nodes connectés (`server.ts:136-140`).

## Stockage local du Node

`DROP_HOME` vaut `~/.drop` ou la variable `DROP_HOME` (`packages/node/src/home.ts:98-100`), créé en 0700 (`:211-213`). Contrat : [spec node](../../openspec/specs/node/spec.md#requirement-contenu-de-drop_home). Tout le tableau est **Existant**.

| Chemin sous `DROP_HOME`             | Contenu                                                                                                                                   | Mode    | Source                                         |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------- | ---------------------------------------------- |
| `identity.json`                     | `Identity`                                                                                                                                | 0600    | `home.ts:214`                                  |
| `config.json`                       | `NodeConfig` : `relayUrl`, `profile` (`legacy` ou `private`), `network?`, `ownerKind`, `apiPort` (7781), `gateways`, `payer`, `funding?` | umask   | `home.ts:41-64`, `:215`                        |
| `local-token`                       | Jeton porteur de l'API locale                                                                                                             | 0600    | `home.ts:217`                                  |
| `peers.json`                        | `nodeId`, `displayName`, `ownerKind`, `pairedAt`, `via?`                                                                                  | umask   | `home.ts:67-74`, `:366-370`                    |
| `capabilities/<id>.json`            | `capabilityId`, `approverNodeIds`, `config` privée du propriétaire, `publishedAt`                                                         | 0600    | `home.ts:78-83`, `:406-408`                    |
| `receipts/AAAA-MM-JJ.jsonl`         | Un reçu signé par ligne                                                                                                                    | 0600    | `home.ts:410-428`                              |
| `received-drops-a.journal`, `received-drops-b.journal` | Format 3 (T3.1e) : en-tête (génération, horloge, empreinte), puis un enregistrement par identifiant reçu (UUIDv7, étiquette hachée du pair, heure) ; un seul journal valide, 16 384 vivants au plus, 1 024 par pair | 0600 | `packages/node/src/replay-store.ts` |
| `received-drops-version`            | `3` (format 2 et antérieurs migrés à la première admission)                                                                                 | 0600    | `replay-store.ts`                              |
| `received-drops-quarantine`         | Fin de la quarantaine après perte d'état, en millisecondes ; absent hors quarantaine                                                       | 0600    | `replay-store.ts`                              |
| `received-drops.lock`               | Propriétaire du verrou d'admission : PID, nonce, hash du nom du poste, démarrage                                                           | 0600    | `replay-store.ts`                              |
| `admission.json`                    | Ticket d'admission en attente                                                                                                             | 0600    | `home.ts:343-349`                              |
| `links.json`                        | Assistants liés : `gateway`, `clientName`, `linkedAt`                                                                                     | 0600    | `home.ts:87-91`, `:372-379`                    |
| `team.json`                         | `team` et `members`                                                                                                                       | umask   | `home.ts:95`, `:381-388`                       |
| `private-migration.json`            | Config avant et après la migration privée                                                                                                 | 0600    | `packages/node/src/private-config.ts:24-25`, `:68` |
| `.private-migration.lock`           | PID pendant la migration                                                                                                                  | 0600    | `private-config.ts:27-47`                      |
| `backups/onboarding/`               | Trois sauvegardes au plus par fichier d'agent, dossier en 0700                                                                            | 0600    | `packages/node/src/onboarding.ts:208-222`      |
| `bin/drop-mcp.mjs`                  | Connecteur MCP copié pour les agents                                                                                                      | 0700    | `onboarding.ts:257-275`                        |

États en mémoire seulement (**Existant**, perdus au redémarrage) : demandes exécutées, émises, cartes d'approbation et enveloppes hors ligne, 1 024 chacune (`packages/node/src/engine.ts:46-50`) ; hash des clés plafonnées à révoquer, 8 192 au plus (`packages/node/src/funding.ts:35`). La reprise après crash reste **Visé** T3.1d et T3.1e.

## Reçus

Contrat : [spec protocol](../../openspec/specs/protocol/spec.md#requirement-aucun-contenu-dans-le-reçu). Tout est **Existant**.

- Champs (`packages/protocol/src/receipt.ts:7-32`) : `dropId`, `capabilityId`, `capabilityVersion`, `requester`, `executor`, `approver`, `inputHash`, `outputHash?`, `decision` (`allow_once`, `deny`, `not_now`, `expired`), `reviewed`, `toolCalls` (nom et nombre), `costUsd?`, `errorCode?`, `timestamps` (`requested`, `decided`, `started`, `finished`, `delivered`), `sig`.
- Hash : SHA-256 hexadécimal de la forme canonique (`packages/protocol/src/encoding.ts:12-14`), pour l'entrée (`engine.ts:1113`) et la sortie (`packages/runner/src/run.ts:164`).
- Signature : par l'exécuteur sur la forme canonique sans `sig` (`receipt.ts:36-43`) ; le destinataire vérifie l'émetteur et la signature avant d'écrire (`engine.ts:1036`).
- Diffusion : écrit chez l'exécuteur puis envoyé au demandeur et à l'approbateur (`engine.ts:1122-1126`).
- Limite : le reçu révèle les noms et le nombre d'appels d'outils, la décision et les horodatages ; c'est une métadonnée, pas un contenu.

## Contrat de capacité

Contrat : [spec protocol](../../openspec/specs/protocol/spec.md#requirement-capabilitycard-identité-et-rôles) et [spec runner](../../openspec/specs/runner/spec.md#requirement-interface-capabilityimpl). Tout est **Existant**.

- `CapabilityCard` (`packages/protocol/src/capability.ts:18-37`) : `id` (forme `a.b`), `version` semver, `owner`, `executorNodeId`, `approverNodeIds` (1 et plus), `title`, `sensitivity`, `inputSchema` et `outputSchema` (JSON Schema), `receives`, `neverReceives`, `approval` (`always` ou `auto_low`), `maxOutputChars`, `budget` (`maxSeconds`, `maxUsd?`, `maxToolCalls?`).
- Carte signée (`capability.ts:41`) : `{ card, sig }` ; acceptée seulement si l'exécuteur nommé est l'expéditeur du catalogue (`packages/protocol/src/cards.ts:11-14`).
- Implémentation (`packages/runner/src/types.ts:21-44`) : `card`, `input`, `output` appliqué en strict, `configSchema`, `preview`, `execute`, `cost?`, `family?`, `cardFor?`. Le runner ne passe à la capacité que `RunContext` (`types.ts:5-18`).
- Capacités livrées (`packages/capabilities/src/index.ts:81`) et leurs configs privées :

| Capacité                   | Config du propriétaire                                                                                       | Entrée                                    | Sortie                                                    | Source                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------- | --------------------------------------------------------- | -------------------------------------------------- |
| `production.error_summary` | `services` et source de logs, `errorPatterns`, `errorLineRegex`, `degradedThreshold`                         | `service`, `window`                       | statut, nombre de lignes, erreurs principales nommées     | `packages/capabilities/src/error-summary.ts:46-90` |
| `repo.answer`              | `repoPath`, `allow`, `maxSnapshotBytes` (20 Mio), `allowSourceExcerpts`, `maxTurns`, `maxUsd`, `provider`    | `question` (10 à 300)                     | `answer` (1 500), `verdict`, `referencedFiles` (10)       | `packages/capabilities/src/repo-answer.ts:20-42`   |
| `mcp.answer.<nom>`         | `label`, `server` (`stdio`, `http` ou `agent`), `tools` (1 à 30), `maxTurns`, `maxUsd`, `provider`           | `question` (10 à 300)                     | `answer` (1 500), `verdict`, `sources` (10)               | `packages/capabilities/src/mcp-answer.ts:29-75`    |
| `a2a.answer.<nom>`         | `label`, `url`, `headersFromEnv`                                                                             | `question` (10 à 300)                     | `answer` (3 000), `verdict`, `sources` (10)               | `packages/capabilities/src/a2a-answer.ts:17-33`    |

- `provider` (`packages/capabilities/src/llm.ts:10-21`) : `baseUrl` (Ollama local par défaut), `model` à nommer, `apiKeyEnv` (nom de variable ou `null`), tarifs par million de jetons.

## Correspondance A2A

Contrat : [spec a2a](../../openspec/specs/a2a/spec.md). Tout est **Existant**, sur `@a2a-js/sdk` 1.3.0 (`packages/a2a/package.json`).

| Objet A2A    | Mise en oeuvre dans drop                                                                                                                                       | Source                                                          |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Agent Card   | Servie sur `/.well-known/agent-card.json` aux clients locaux ; interface JSON-RPC 1.0, sans streaming ni push ; jeton porteur déclaré ; un skill par capacité qui prend une question. | `packages/a2a/src/tasks.ts:6-43`, `packages/node/src/api.ts:152`, `packages/node/src/a2a-inbound.ts:25-46` |
| Message      | Texte du message utilisateur, tronqué à 300 caractères, routé comme `ask_team`.                                                                                | `a2a-inbound.ts:50-52`                                          |
| Task         | `SUBMITTED` puis `WORKING` ; fin en `COMPLETED`, `REJECTED` (tous ont refusé), `FAILED` ou `INPUT_REQUIRED` (aucun destinataire) ; attente de 10 minutes.     | `tasks.ts:45-99`, `a2a-inbound.ts:14`, `:53-119`                |
| Artifact     | Un par réponse : partie texte qui signale une donnée, plus partie JSON de la sortie validée.                                                                   | `tasks.ts:80-90`, `a2a-inbound.ts:93-103`                       |
| Stockage     | `InMemoryTaskStore` du SDK.                                                                                                                                     | `packages/a2a/src/server.ts:28`                                 |
| Sortant      | `a2a.answer` lit la carte de l'agent joint, envoie la question encadrée, lit artifacts et état ; refus et question en retour finissent en `E_RUNNER`.          | `packages/a2a/src/messages.ts:52-76`, test « ends a refusal, a question back or a failure as E_RUNNER, never with the agent own words » |

API locale et MCP du demandeur (**Existant**) : routes `GET /peers`, `GET /capabilities`, `POST /drops`, `POST /ask`, `POST /a2a`, `GET /drops/:id`, panneau `/app` et routes `/ui/*` (`packages/node/src/api.ts:172-445`) ; vues renvoyées à `requester-mcp` (`packages/requester-mcp/src/client.ts:6-30`) ; six outils MCP (`packages/requester-mcp/src/server.ts:21-36`).

## Schémas cibles (propositions non normatives)

Mise à jour du 11 octobre 2026 : le fait publié (T4.4), la réponse humaine (T4.3), la politique d'entreprise (T4.10) et les réglages de connexion (T4.2, T4.2b) sont **Existant**, avec leurs schémas zod dans `packages/protocol/src/` (`fact.ts`, `human-answer.ts`, `policy.ts`, `iroh.ts`) et dans `packages/node/src/home.ts`. Les propositions ci-dessous datent d'avant ces tâches : pour elles, le code et les specs font foi. Le reste est **Visé** et seulement proposé. Les noms de champs sont des pistes ; la tâche citée écrit le schéma zod et la spec normative. Chaque objet signé réutiliserait la forme canonique et la signature Ed25519 existantes (`canonical.ts`, `identity.ts:34-47`) : **Hypothèse**, à confirmer par chaque spec.

### Fait publié

Spécifié par **T4.4** (niveau 1, D50, D51).

| Champ                   | Proposition                                                         |
| ----------------------- | ------------------------------------------------------------------- |
| `factId`                | UUIDv7.                                                             |
| `statement`             | Énoncé court, borné en caractères.                                  |
| `owner`                 | `Owner` existant (`capability.ts:8-12`).                            |
| `source`                | Libellé et référence facultative, jamais le contenu de la source.   |
| `validFrom`, `validTo`  | Horodatages ; un fait expiré n'est plus servi.                      |
| `audience`              | Équipe, liste de `NodeId` ou public d'une capacité.                 |
| `sensitivity`           | `low` ou `high`, comme les cartes.                                  |
| `status`                | `active`, `expired` ou `invalidated` avec `invalidatedBy?`.         |
| `sig`                   | Signature du propriétaire.                                          |

Stockage proposé : sous `DROP_HOME`, chez le propriétaire seulement. **Hypothèse** : un fichier JSONL par propriétaire suffit pour les volumes de P1 ; critère : mesure T4.4.

### Entrée du catalogue de sujets

Spécifié par **T4.12**. Champs proposés : `topic` (libellé court), `ownerNodeId`, `updatedAt`, `factCount?`, `sig`. Aucun énoncé ni source. Limite connue (D51) : le catalogue révèle qui sait quoi.

### Suggestion

Spécifié par **T4.12**. Champs proposés : `suggestionId` (UUIDv7), `from`, `target` (`factId` ou `topic`), `proposedStatement`, `reason?`, `createdAt`, `expiresAt`, `state` (`pending`, `accepted`, `rejected`), `decidedAt?`. Seul l'humain propriétaire fait passer une suggestion à `accepted` ; aucun agent n'écrit chez un autre.

### Réponse humaine

Spécifié par **T4.3** (D49). Champs proposés : `dropId`, `kind` (`text` ou `file`), `text?`, `file?` (`name`, `mediaType`, `size`, `sha256`), `answeredAt`. Elle passe par la même validation de sortie et le même reçu que le runner, avec `reviewed` à vrai. **Hypothèse** : un fichier tient dans l'enveloppe de 256 Kio ; critère : spec T4.3 qui fixe la limite ou un découpage.

### Contrat de tâche déléguée

Spécifié par **T4.11** (niveau 4, D50).

| Champ                   | Proposition                                                                        |
| ----------------------- | ---------------------------------------------------------------------------------- |
| `taskId`, `dropId`      | Identifiant de la `Task` A2A et du Drop qui la porte.                              |
| `scope`                 | Capacités ou contexte déclaré couverts ; tout élargissement exige une ré-approbation. |
| `tools`                 | Liste fixée à l'approbation, jamais choisie par le modèle.                         |
| `budget`                | `maxUsd`, `maxToolCalls`, `maxSeconds`, comme `CapabilityCard.budget`.             |
| `deadline`              | Expiration absolue.                                                                |
| `milestones`            | Liste de jalons (`id`, `description`, `requiresApproval`), exposés en `INPUT_REQUIRED`. |
| `state`                 | Correspondance avec les états de `Task` A2A.                                       |

### Politique d'entreprise

Spécifié par **T4.10** (D54).

| Champ                    | Proposition                                                                            |
| ------------------------ | -------------------------------------------------------------------------------------- |
| `policyId`, `version`    | Identifiant et version croissante.                                                     |
| `issuer`                 | Clé publique de l'organisation, distribuée par MDM.                                    |
| `issuedAt`, `expiresAt`  | Validité.                                                                              |
| `allowedClients`         | Identifiants parmi les treize clients de T4.5.                                         |
| `allowedProviders`       | Origines de modèles permises, au format de `PrivateNetwork`.                           |
| `relays`                 | Relais internes permis ; `requireInternalRelay`.                                       |
| `gateways`               | `allowed` à faux par défaut en entreprise ; liste blanche sinon.                       |
| `sig`                    | Signature de l'émetteur.                                                               |

Le poste l'applique ; le relais la revérifie. **Hypothèse** : le relais ne reçoit qu'une empreinte de la politique à l'authentification ; critère : spec T4.10.

### Réglages de connexion

Spécifié par **T4.2** (D53). Champs proposés : `modes` (`lan`, `iroh`, `relay`, chacun activable), `relays` (liste d'URL), `fallbackRelay` (`none` par défaut, ou `n0_test`, `memolabs`, `self_hosted`), `fallbackConsentAt?` (horodatage de l'activation explicite), `policyRef?`. Le relais de test n0 est marqué comme tiers dans l'interface.

### Événement de simulation

Spécifié par **T4.1** pour la base et **T4.7** pour la carte (D56). Champs proposés : `campaignId`, `runId`, `seq`, `t` (ms depuis le début), `kind` (`node_up`, `node_down`, `envelope_sent`, `delivered`, `approval_shown`, `decision`, `result`, `error`, `fault_injected`), `from?`, `to?`, `dropId?`, `level` (1 à 4), `latencyMs?`, `code?`, `persona?`, `contentHash?`. Jamais de question ni de réponse en clair, comme les reçus.

[tasks]: ../TASKS.md
