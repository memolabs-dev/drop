# TRD : exigences techniques de drop

Document descriptif. Les contrats normatifs vivent dans openspec/specs ; l'ordre dans docs/TASKS.md ; les décisions dans docs/DECISIONS.md.

Rédigé le 10 octobre 2026 dans la change `t4-0-product-docs` (T4.0), à partir de D47 à D58. Depuis T4.0a, [`openspec/project/architecture.md`](../../openspec/project/architecture.md) en est le résumé ; ce document fait foi pour la cible technique décrite par D47 à D58. Statuts mis à jour le 11 octobre 2026 pour les tâches livrées depuis ; les références de ligne datent de la rédaction.

## 1. Objet et lecture

Ce document dit ce que le système fait aujourd'hui, ce qu'il doit faire demain et ce qui reste à prouver. Il ne crée aucune exigence : chaque contrat se lit dans la spec liée, chaque ordre dans [l'index des tâches][tasks].

| Marqueur      | Sens                                         | Preuve exigée                                                    |
| ------------- | -------------------------------------------- | ---------------------------------------------------------------- |
| **Existant**  | Livré et vérifiable dans ce dépôt.           | Chemin de fichier (avec ligne), nom de test ou preuve archivée.  |
| **Visé**      | Cible adoptée, pas encore livrée.            | Tâche T3.\* ou T4.\* de [l'index][tasks] qui la livre.           |
| **Hypothèse** | Supposé, non vérifié.                        | Critère qui la confirme ou l'invalide.                           |

Les chemins de code sont relatifs à la racine du dépôt. Les sources externes sont citées par section de [la recherche du 10 octobre][r0] : [douleurs et concurrents][r1], [connexion][r2], [interactions][r3], [clients MCP][r4], [simulation][r5]. Le vocabulaire (Node, capacité, Drop, reçu) est celui de [la vision](../../openspec/project/vision.md#vocabulaire).

## 2. Système actuel

### 2.1 Paquets

Tous **Existant**, dans un monorepo pnpm sans étape de build en développement (D16) ; `scripts/bundle.ts` assemble seulement la distribution.

| Paquet                      | Responsabilité                                                                                         | Fichiers clés                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `packages/protocol`         | Schémas zod, identité, enveloppe, reçu, invitation, admission, politique réseau privée. Aucune I/O.    | `src/messages.ts`, `src/envelope.ts`, `src/identity.ts`, `src/receipt.ts`        |
| `packages/relay`            | Relais WebSocket `/v1` : défi signé, admission, file en mémoire, débit par identité, `/health`.        | `src/server.ts`, `src/wire.ts`, `src/config.ts`                                  |
| `packages/node`             | Daemon, moteur, API locale, panneau `/app`, CLI, raccordement des agents, routage `ask_team`, équipe. | `src/engine.ts`, `src/api.ts`, `src/home.ts`, `src/onboarding.ts`                |
| `packages/runner`           | Pipeline d'exécution : entrée, budget, sortie stricte, taille, scanner de secrets, reçu.               | `src/run.ts`, `src/secrets.ts`, `src/types.ts`                                   |
| `packages/capabilities`     | `production.error_summary`, `repo.answer`, `mcp.answer`, `a2a.answer`, client LLM, transport privé.   | `src/index.ts:81`, `src/llm.ts`, `src/private-network.ts`, `src/agents.ts`       |
| `packages/requester-mcp`    | Serveur MCP stdio du demandeur, six outils, parle seulement à l'API locale.                            | `src/server.ts:21-36`, `src/client.ts:77-86`                                     |
| `packages/a2a`              | A2A v1.0 entrant et sortant sur `@a2a-js/sdk` 1.3.0 (D33).                                             | `src/server.ts`, `src/tasks.ts`, `src/client.ts`                                 |
| `packages/gateway`          | Connecteur distant OAuth et MCP HTTP pour ChatGPT et Claude (D31), hors profil privé.                  | `src/server.ts`, `src/oauth.ts`, `src/bridge.ts`                                 |
| `packages/blocked-observer` | Mesure de l'étape 0 (D2, D24).                                                                         | `src/store.ts`, `src/cli.ts`                                                     |
| `apps/desktop`                  | Coque Tauri 2 : icône de barre de menus, lien profond, démarrage automatique, panneau du Node.         | `apps/desktop/src-tauri/Cargo.toml`, `apps/desktop/src-tauri/src/main.rs`                |
| `scripts/bundle.ts`         | Produit `dist/drop.mjs`, `dist/drop-mcp.mjs`, `dist/drop-relay.mjs` et `dist/drop.mcpb`.               | `scripts/bundle.ts:3-6`                                                          |

### 2.2 Processus et ports

| Processus             | Écoute                                                                                      | Sortant                       | Statut et preuve                                                                                                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Relais `drop-relay`   | `host:port` de sa config, `127.0.0.1` par défaut ; `/v1` WebSocket et `GET /health`.        | Aucun.                        | **Existant** : `packages/relay/src/server.ts:27`, `:136-141`, `:321`.                                                                                                                |
| Node `drop serve`     | API locale sur `127.0.0.1:apiPort` (7781 par défaut), jeton porteur et contrôle de `Host`.  | WebSocket vers le relais.     | **Existant** : `packages/node/src/api.ts:125-149`, `:466`, `packages/node/src/home.ts:47` ; tests « refuses to start with a missing or empty local token ».                          |
| Runner                | Aucune écoute : bibliothèque appelée par le moteur du Node.                                 | Destinations des capacités.   | **Existant** : appel `runCapability` dans `packages/node/src/engine.ts:933` ; aucun `listen` ni `createServer` dans `packages/runner/src`.                                            |
| `requester-mcp`       | Aucune : stdio, lancé par l'agent.                                                          | HTTP vers l'API locale.       | **Existant** : `packages/requester-mcp/src/client.ts:77-86`.                                                                                                                         |
| Passerelle `gateway`  | `127.0.0.1:7790` derrière un proxy inverse public.                                          | Relais public historique.     | **Existant** hors profil privé : `packages/gateway/src/cli.ts:5-17`, `packages/gateway/src/server.ts:248`.                                                                            |
| App Mac               | Aucune en propre ; affiche `/app` du Node qu'elle a démarré (D46).                         | Aucun.                        | **Existant** : build signée et notarisée pour Apple Silicon ([preuve](../../openspec/changes/t3-4-private-mac-app/proof/verification.md)) ; recette sur Mac propre et VoiceOver **Visé** T3.4 (`blocked`).                                                                  |

Le processus Node qui héberge le runner écoute sur la boucle locale pour son API : la règle « le runner n'écoute aucun port » porte sur le runner, pas sur l'API du Node (**Existant**, [spec runner](../../openspec/specs/runner/spec.md#requirement-aucun-port-en-écoute) et [spec node](../../openspec/specs/node/spec.md#requirement-écoute-de-lapi-locale)).

### 2.3 Flux d'une demande

Chaque étape est **Existant** ; le test « end to end, in memory: relay and three nodes » (`packages/node/test/e2e.test.ts`) et « private system > runs two private nodes with internal MCP and model through consent failure and restart » (`packages/node/test/private-system.test.ts`) la couvrent.

1. L'agent appelle `ask_team`, `request_drop` ou `request_drops` ; `requester-mcp` appelle `POST /ask` ou `POST /drops` de l'API locale (`packages/node/src/api.ts:190`, `:218`). Un client A2A passe par `POST /a2a` (`:214`).
2. Le Node demandeur scelle un `drop_request` (UUIDv7) chiffré et signé, puis l'envoie au relais (`packages/protocol/src/envelope.ts:50-80`).
3. Le Node exécuteur ouvre l'enveloppe dans l'ordre fixe des contrôles (`envelope.ts:126-178`), refuse un financement non sollicité en profil privé, valide l'entrée sans rien exécuter, pose un marqueur anti-rejeu durable (`packages/node/src/engine.ts:781-814`, `packages/node/src/home.ts:221-327`), puis envoie un `approval_request` à chaque approbateur (`engine.ts:889`).
4. L'approbateur décide `allow_once`, `deny` ou `not_now` dans le panneau (`POST /ui/decide`, `api.ts:427`) ; la décision revient en `approval_decision` signé.
5. Le runner exécute avec les outils et budgets fixés par la capacité (`engine.ts:933`), puis rejette toute sortie invalide, trop longue ou contenant un secret (`packages/runner/src/run.ts:57-74`).
6. En sensibilité `high`, un `review_request` précède l'envoi ; l'état `in_review` n'existe que dans ce cas (`packages/protocol/src/lifecycle.ts:18-31`).
7. Le résultat part en `drop_result` ; l'exécuteur signe le reçu, l'écrit et l'envoie au demandeur et à l'approbateur (`engine.ts:1122-1126`), qui vérifient la signature avant de l'écrire (`engine.ts:1036`).

### 2.4 Écarts connus entre l'existant et la cible

- **Existant** : treize clients détectés (`packages/capabilities/src/clients.ts`), sept raccordés automatiquement et six par configuration à copier (T4.5).
- **Existant** : la file du relais vit en mémoire et se perd au redémarrage (`packages/relay/src/server.ts:134`) ; la file hors ligne du Node est volatile (`docs/PRIVATE_PROFILE.md`, section « Exploiter le relais »).
- **Existant** : un seul relais configuré par Node ; réseau local (T4.2) et iroh (T4.2b) passent avant lui.
- **Existant** : T3.1b et T3.1c sont closes le 11 octobre 2026 après revue finale (`openspec/changes/archive/2026-10-11-t3-1b-replay-storage-bounds/proof/verification.md`, `openspec/changes/archive/2026-10-11-t3-1c-replay-store-hardening/proof/verification.md`) ; le constat CSO HIGH de mémoire est clos par revue et tests, l'audit CSO restant partiel ([index][tasks]). Les suites T3.1d, T3.1e et T3.1f restent des prérequis avant tout pilote.

## 3. Architecture visée par phase

Les phases P0 à P5 viennent de D58 ; leur détail et leurs critères de sortie sont dans [le plan d'implémentation](IMPLEMENTATION_PLAN.md), leur ordre et leurs statuts dans [l'index][tasks]. Au 11 octobre 2026, T4.0, T4.0a, T4.1, T4.2 à T4.5 et T4.10 sont livrées ; le reste est **Visé**.

| Phase                  | Apport technique                                                                                      | Tâches                         |
| ---------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------ |
| P0                     | Documents produit, puis mise en vérité des documents et specs existants.                              | T4.0, T4.0a                    |
| Avant P1               | Banc de simulation minimal : relais dédié, 50 nœuds, faux agents déterministes, mesures.              | T4.1                           |
| P1                     | Modes de connexion, réponse humaine, faits publiés, treize adaptateurs MCP, mesure du besoin (T0.7), essai en binômes de collègues.     | T4.2 à T4.6, avec T3.1b à T3.5 |
| P2                     | Simulation complète : 500 nœuds virtuels, personnages, carte, traces, boucle d'amélioration bornée. | T4.7                           |
| P3                     | Agent inclus, petite question (niveau 2), pack entreprise et politique signée.                        | T4.8, T4.9, T4.10              |
| P4                     | Tâches déléguées (niveau 4) et contexte partagé décentralisé.                                         | T4.11, T4.12                   |
| P5                     | Nom, offre, lancement public, après accord humain.                                                    | T4.13                          |

Forme cible des composants (chaque bloc renvoie à sa tâche ; T4.2 à T4.5 et T4.10 existent, T4.8, T4.9 et T4.11 sont **Visé**) :

```text
Agent (13 clients MCP, T4.5) ── stdio ──> requester-mcp ──> API locale ──> Node
Client A2A interne ─────────────────────────────────────> /a2a ──────────> Node
Node <── connexion : mDNS local | iroh (drop-iroh) | relais d'entreprise (T4.2, T4.2b, T4.10)
Node ──> runner ──> capacité (niveau 3) | fait publié (niveau 1, T4.4)
                   | petite question (niveau 2, T4.9) | tâche déléguée (niveau 4, T4.11)
Node ──> réponse humaine (T4.3) | agent inclus (T4.8)
Politique signée par MDM ──> appliquée par le Node, revérifiée par le relais (T4.10)
```

## 4. Modes de connexion (D53)

**Existant** (source) : A2A v1.0 suppose des endpoints HTTPS joignables et ne traite ni découverte locale, ni NAT, ni pair à pair ([connexion][r2]). drop doit donc fournir son propre transport.

| Mode                      | Mécanisme                                                                    | Statut                                                                                                                                                            |
| ------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Relais interne actuel     | WebSocket `ws` ou `wss`, défi signé, admission.                              | **Existant** : `packages/relay/src/server.ts` ; TLS testé par « connects to the internal relay through trusted TLS and rejects an untrusted certificate ».          |
| Réseau local              | Découverte mDNS des Nodes du même lien.                                      | **Existant** T4.2 (`packages/node/src/lan.ts`, `bonjour-service`, D61).                                                                                                                                                    |
| Internet                  | iroh dans un programme Rust séparé, connexion QUIC directe avec traversée de NAT. | **Existant** T4.2b (`crates/drop-iroh`, `packages/node/src/iroh.ts`, D68).                                                                                                                                                    |
| Entreprise                | Relais drop interne en binaire, image Docker et chart Helm, TLS sur 443.     | **Existant** T4.10 : image (`docker/relay.Dockerfile`), chart (`deploy/helm/drop-relay`), TLS natif facultatif. Binaire autonome **Visé** T4.10b. |

- **Existant** T4.2b : aucun relais iroh par défaut. Le panneau propose : désactivé, relais auto-hébergé ou d'équipe, relais de test n0 signalé comme tiers et refusé en profil privé (D68). Sans relais, deux pairs derrière un routeur ne se joignent pas. L'activation est explicite et réversible. Un relais Memo Labs sur demande d'une équipe reste une **Hypothèse**.
- **Existant** : aucun repli silencieux ; l'ordre est réseau local, iroh, relais drop, puis file d'attente. Le profil privé valide l'unique `relayUrl` contre la liste d'origines.
- **Existant** : le chiffrement de bout en bout reste celui de l'enveloppe (`envelope.ts:50-80`), quel que soit le transport.
- **Hypothèse** : iroh connecte directement environ 9 cas sur 10 ([connexion][r2]) ; libp2p mesure 70 % ± 7,1 %. Critère : taux mesuré dans T4.1 ou T4.6 sur les réseaux réels des testeurs.
- **Hypothèse** : l'UDP sortant est souvent bloqué en entreprise, d'où un besoin de repli TCP sur 443 ([connexion][r2], inférence). Critère : essai T4.10 derrière un pare-feu d'entreprise.
- **Existant** (décision D68, D61) : iroh tourne dans un programme Rust séparé, `crates/drop-iroh`, piloté par l'entrée et la sortie standard, et non par les liaisons Node.js d'iroh, écartées.

## 5. Modèle de sécurité

Les contrats sont dans les specs [protocol](../../openspec/specs/protocol/spec.md), [relay](../../openspec/specs/relay/spec.md), [node](../../openspec/specs/node/spec.md) et [runner](../../openspec/specs/runner/spec.md). Le tableau décrit leur mise en oeuvre.

| Mécanisme                       | Mise en oeuvre                                                                                                                                                                  | Statut et preuve                                                                                                                                         |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identité                        | Paire Ed25519 ; `nodeId` = clé publique en base64url de 43 caractères.                                                                                                          | **Existant** : `packages/protocol/src/identity.ts:6`, `:21-32`.                                                                                          |
| Chiffrement de bout en bout     | Clés X25519 dérivées de l'identité ; corps chiffré par `crypto_box_easy`.                                                                                                       | **Existant** : `identity.ts:50-61`, `envelope.ts:61-66` ; test « round trip sign, encrypt, verify, decrypt ».                                           |
| Enveloppe signée                | Signature Ed25519 sur la forme canonique de tous les champs sauf `sig` ; contrôles dans un ordre fixe avec codes stables.                                                      | **Existant** : `envelope.ts:35-38`, `:126-178`, `packages/protocol/src/canonical.ts` ; test « every error code in the specified order ».                |
| Admission au relais             | Défi signé, liste d'autorisation, ticket d'admission à usage unique signé par un parrain admis, quota de parrainage, révocation prioritaire, émetteur usurpé fermé en 4403. | **Existant** : `packages/relay/src/server.ts:112-131`, `:180-184`, `:209-259`, `packages/relay/src/config.ts:17-25` ; tests du relais (`packages/relay/test/relay.test.ts`). |
| Débit par identité              | Fenêtre d'une minute par `nodeId`, conservée à la reconnexion.                                                                                                                  | **Existant** : `server.ts:153-168` ; test « keeps a node rate limit after reconnect ».                                                                   |
| Anti-rejeu des enveloppes       | Cache borné à 65 536 identifiants dans la fenêtre de 30 minutes, refus fermé à saturation.                                                                                      | **Existant** : `envelope.ts:83-101` ; test « refuses new ids at capacity without forgetting an unexpired id ».                                          |
| Anti-rejeu des demandes (T3.1b) | `dropId` UUIDv7 obligatoire ; marqueurs durables avec horloge monotone, version, empreinte et verrou ; plafond de 16 384.                                                        | **Existant**, revue formelle en attente : `packages/protocol/src/messages.ts:10`, `packages/node/src/home.ts:39`, `:221-327` ; test « fails closed if one recent marker disappears while the directory remains ». |
| États mémoire bornés (T3.1c)    | 1 024 demandes reçues, émises, cartes et enveloppes hors ligne ; 8 192 clés plafonnées suivies.                                                                                 | **Existant**, ligne `blocked` (CSO HIGH) : `packages/node/src/engine.ts:46-50`, `packages/node/src/funding.ts:35`.                                     |
| Suite anti-rejeu                | Quotas par pair, récupération après crash, compatibilité `E_RATE`, durabilité des révocations.                                                                                  | **Existant** T3.1e pour la part par pair, la reprise après crash ou perte d'état et l'admission durable sans renommage ; **Visé** T3.1d pour `E_RATE` et les révocations. |
| Consentement                    | Carte sans identifiant technique, bouton par défaut « Pas maintenant », décision signée.                                                                                        | **Existant** dans le panneau `/app` depuis T4.14 et sur la page historique `/` : `packages/protocol/src/messages.ts:42-52`, `packages/node/src/ui.ts:63` ; test « consent UI > shows no technical identifier and defaults to « Pas maintenant » ». Absent du panneau `/app` servi par l'app Mac (écart E1, **Visé** T4.14).       |
| Requête d'un pair = donnée      | La question est encadrée et échappée avant tout modèle ou agent joint.                                                                                                          | **Existant** : `frameForAgent` dans `packages/capabilities/src/a2a-answer.ts` ; [spec runner](../../openspec/specs/runner/spec.md#requirement-requête-dun-pair-traitée-comme-donnée-non-fiable). |
| Outils fixés par la capacité    | Le propriétaire choisit les outils à la publication ; le modèle ne voit que cette liste.                                                                                        | **Existant** : `packages/capabilities/src/mcp-answer.ts:54-64` (`tools`) ; [spec runner](../../openspec/specs/runner/spec.md#requirement-outils-figés-par-la-capacité). |
| Sortie validée                  | Schéma strict sans réparation, taille maximale, scanner de secrets ; refus plutôt que réparation.                                                                              | **Existant** : `packages/runner/src/run.ts:57-74`, `packages/runner/src/secrets.ts` ; tests « rejects an unexpected nested field instead of stripping it », « fails with E_SECRET_DETECTED for a secret in a nested array and returns no output ». |
| Destinations privées            | Origines IP privées littérales, sans DNS, redirection ni proxy implicite.                                                                                                       | **Existant** : `packages/protocol/src/private-network.ts`, `packages/capabilities/src/private-network.ts` ; test « rejects public addresses, DNS names, credentials and unlisted origins before transmission ». |
| Clés et jeton en 0600           | `identity.json`, `local-token`, publications et reçus en 0600 ; `DROP_HOME` en 0700.                                                                                            | **Existant** : `packages/node/src/home.ts:102-105`, `:209-218` ; test « creates a local token with owner-only permissions ».                            |
| Journaux sans contenu           | Le relais journalise identifiants, tailles et issues, jamais `body`.                                                                                                             | **Existant** : `packages/relay/src/server.ts:38-48`.                                                                                                     |
| Télémétrie                      | Aucune.                                                                                                                                                                         | **Existant** : aucun code de télémétrie dans `packages/*/src` (recherche du 10 octobre 2026) ; conclusion T3.1 (`openspec/changes/archive/2026-10-09-t3-1-private-profile/closure.md`). |

### 5.1 Promesse publique (D52) et sa limite

La promesse adoptée : « Tes données restent sur ta machine. Seule une réponse que tu as approuvée en sort, chiffrée, vers la personne qui l'a demandée. Aucun index central, aucun serveur qui lit, code ouvert et journal local de tout ce qui est sorti. »

- **Existant** : consentement avant exécution, chiffrement de bout en bout, relais aveugle au contenu, reçus locaux (section 5).
- **Existant** : le journal local des reçus garde des hash et des métadonnées, pas le contenu sorti (`packages/protocol/src/receipt.ts:7-32`). « Journal de tout ce qui est sorti » signifie donc aujourd'hui « trace vérifiable », pas copie.
- **Existant** T3.6 : « code ouvert » ; le dépôt est public et open source (Apache-2.0) depuis le 11 octobre 2026. Aucun téléchargement n'est encore publié.
- **Existant** (limite, D52) : drop contrôle ce qui passe par drop. Un connecteur MCP, un modèle ou un agent A2A choisi par le propriétaire peut avoir ses propres flux ([profil privé](../PRIVATE_PROFILE.md#frontière-prise-en-charge)).
- **Existant** (limite) : le relais voit `from`, `to`, `id`, `ts`, `exp` et la taille de chaque enveloppe (`packages/protocol/src/envelope.ts:22-32`).

## 6. Politique d'entreprise (D54)

- **Existant** : chaque Node porte sa liste d'origines privées (`packages/node/src/home.ts:45`) et sa liste de passerelles de confiance (`:49`) ; le profil privé refuse passerelles et financement reçu (`:58`).
- **Existant** T4.10 (`packages/node/src/policy.ts`, D81) : une politique signée, déployée par l'informatique via MDM, fixe les clients autorisés, les fournisseurs de modèles, les relais permis, l'interdiction des passerelles publiques et le relais interne obligatoire. Le poste l'applique avant toute connexion ; le relais interne la vérifie à nouveau. Forme proposée dans [le schéma backend](BACKEND_SCHEMA.md#politique-dentreprise).
- **Existant** T4.10 : une entreprise peut interdire un client précis ou un fournisseur précis.
- **Hypothèse** : un client interdit n'est simplement pas proposé au raccordement, car l'API locale ne peut pas identifier de façon fiable le client qui l'appelle (`requester-mcp` déclare lui-même `DROP_AGENT`, `packages/node/src/onboarding.ts:58`). Critère : spec T4.10 qui fixe le point d'application.
- **Existant** (source secondaire) : ChatGPT n'accepte qu'un serveur MCP distant en HTTPS ([clients MCP][r4]) ; d'où la passerelle facultative de D31 (`packages/gateway`). **Hypothèse** à revérifier dans l'aide officielle avant T4.10.
- **Existant** T4.10 (`gatewayAllowed`) : la passerelle reste optionnelle et interdictible, avec la garantie qu'aucun flux ne touche ce serveur quand la politique l'interdit.
- **Hypothèse** : le relais peut revérifier la politique à partir d'une empreinte présentée à l'authentification. Critère : scénario T4.10 où un Node à politique absente ou périmée est refusé par le relais.

## 7. Échelle des échanges et A2A (D50)

| Niveau | Échange                                                                          | Forme A2A                                                                    | Statut                                                                              |
| ------ | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 1      | Fait publié, servi sans modèle.                                                  | `Message` direct, sans `Task`.                                               | **Existant** T4.4 côté drop (carte `fact.f<hex>`) ; forme A2A non vérifiée ici.                                                                      |
| 2      | Petite question, appel neuf sans outil, sur un contexte déclaré partageable.     | `Message` si la réponse est immédiate, sinon `Task` courte.                  | **Visé** T4.9 ; le choix `Message` ou `Task` est une **Hypothèse** tranchée en T4.9. |
| 3      | Capacité publiée.                                                                | `Task` : `WORKING` pendant l'accord, puis `COMPLETED`, `REJECTED`, `FAILED` ou `INPUT_REQUIRED`, une réponse par artifact. | **Existant** : `packages/node/src/a2a-inbound.ts:48-120`, `packages/a2a/src/tasks.ts:45-99`. |
| 4      | Tâche déléguée longue.                                                           | `Task` avec jalons `INPUT_REQUIRED`, ré-approbation si le périmètre s'élargit, budget, expiration. | **Visé** T4.11.                                                                     |
| 5      | Conversation libre entre agents.                                                 | Aucune.                                                                      | Exclu par D50.                                                                      |

- **Existant** : aujourd'hui toute requête A2A entrante produit une `Task`, même sans destinataire (`INPUT_REQUIRED`, `a2a-inbound.ts:54-67`) ; l'attente maximale est de 10 minutes (`:14`).
- **Existant** : le magasin de tâches A2A est en mémoire (`packages/a2a/src/server.ts:28`) ; une tâche se perd au redémarrage. **Visé** T4.11 : un magasin durable pour le niveau 4.
- **Existant** (source) : `AUTH_REQUIRED` ne vaut pas autorisation ; l'autorisation reste à l'implémentation ([interactions][r3]). drop garde sa propre décision signée.
- **Existant** (raisons de l'exclusion du niveau 5, [interactions][r3]) : AgentLeak mesure 68,8 % de fuite dans les messages entre agents contre 27,2 % dans la sortie finale ; ConVerse atteint jusqu'à 88 % d'attaques de confidentialité réussies ; OWASP classe la communication inter-agents non sécurisée (ASI07) et interdit de déléguer l'autorisation au LLM (LLM07).
- **Existant** (décision D50, `docs/DECISIONS.md`) : ordre de livraison des niveaux 3, 1, 2 puis 4 ; l'ordre des tâches reste celui de [l'index][tasks].

## 8. Contexte partagé décentralisé (D51)

Les faits publiés sont **Existant** (T4.4, D65) ; le catalogue, les suggestions et l'invalidation sont **Visé** (T4.12). Les formes de données sont dans [le schéma backend](BACKEND_SCHEMA.md#schémas-cibles-propositions-non-normatives).

- **Existant** T4.4 : un fait est signé par l'identité Ed25519 de son propriétaire et reste sur son Node, sous `DROP_HOME`.
- **Existant** T4.4 : le Node sert un fait sans modèle, seulement à son public déclaré, et plus du tout après sa date de fin.
- **Visé** T4.12 : seul un catalogue de sujets sans contenu circule entre Nodes.
- **Visé** T4.12 : aucun agent n'écrit chez un autre : une proposition entre dans une boîte de suggestions validée par l'humain.
- **Visé** T4.12 : un fait contredit est invalidé, pas effacé, pour garder la trace.
- **Existant** (limites écrites dans D51) : une réponse livrée ne se rappelle pas ; le catalogue révèle qui sait quoi ; des réponses partielles peuvent s'agréger.
- **Existant** (risques sourcés, [interactions][r3]) : empoisonnement de mémoire (MINJA, AgentPoison) et mémoire partagée sans authentification (Mem0 CVE-2026-59705). Ils justifient la validation humaine et l'absence d'écriture distante.
- **Hypothèse** : le catalogue de sujets peut réutiliser l'échange `catalog_request` et `catalog` existant (`packages/protocol/src/messages.ts:105-106`). Critère : spec T4.12 qui le confirme ou définit un message distinct.

## 9. Modèles

- **Existant** : le propriétaire choisit un endpoint compatible OpenAI appelé par `fetch`, sans SDK ; `baseUrl`, `model` et `apiKeyEnv` (nom de variable, jamais la clé) sont dans sa config (`packages/capabilities/src/llm.ts:10-21`).
- **Existant** : la valeur par défaut est Ollama local et le modèle doit être nommé explicitement, sans téléchargement ni repli (`llm.ts:11-13`, D40).
- **Existant** : en profil privé, une panne ne change pas de fournisseur ([spec runner](../../openspec/specs/runner/spec.md#requirement-panne-sans-repli)) ; test « private system > runs two private nodes with internal MCP and model through consent failure and restart ».
- **Existant** : les capacités déterministes n'appellent aucun modèle (`production.error_summary`, [spec](../../openspec/specs/capability-error-summary/spec.md)).
- **Existant** hors profil privé : le financement par clé plafonnée OpenRouter (D27) vit dans `packages/node/src/funding.ts` ; le profil privé le refuse (test « refuses unsolicited funding in an owner-paid private profile before consent »).
- **Visé** T3.2 : qualification d'un modèle local (Qwen3.5 4B et 9B candidats, [MODELS](../MODELS.md)). **Visé** T3.2a : évaluation d'AI SDK et de LiteLLM avant toute adoption.
- **Visé** T4.8 : agent inclus qui répond pour le propriétaire après accord, avec le modèle qu'il a choisi.
- **Visé** T4.7 : la simulation n'utilise que des modèles gratuits, via la passerelle LiteLLM du lab (`lab-fast`, `lab-agent`) et une clé virtuelle dédiée, appels espacés (D56).
- **Existant** (mesure) : le quota gratuit de Groq ne tient pas les rafales ([simulation][r5]).

## 10. Adaptateurs des clients MCP (D55)

- **Existant** T4.5 : treize clients (`packages/capabilities/src/clients.ts`). Sept raccordés automatiquement : Claude Code, Claude Desktop, Cursor, Codex, Gemini CLI, VS Code, Cline. Six par configuration à copier : OpenCode, Devin Desktop, Zed, goose, Roo Code, JetBrains AI.
- **Existant** : raccordement en deux confirmations (T3.3), relecture d'empreinte, sauvegarde privée limitée à trois versions (`packages/node/src/onboarding.ts:208-222`) ; CLI officielles pour Claude Code et Codex (D45) ; tests « local agent onboarding (T3.3) » dans `packages/node/test/onboarding.test.ts`.
- **Existant** : la détection lit des chemins connus et n'affiche jamais une valeur secrète (`packages/node/src/detect.ts:5-11`) ; test « lists each agent, whether drop is installed, and what each server is, without any secret value ».
- **Existant** T4.5 : treize clients avec leurs configurations globales et par projet (liste et emplacements dans [clients MCP][r4]), configuration copiable pour les autres. Aucun modèle ne fouille la machine ni ne décide de ce qui est branché.
- **Existant** T4.5 : chaque emplacement a été revérifié dans la doc de la version installée avant d'écrire l'adaptateur.
- **Existant** T4.5 : le champ `requestedBy.agent` du protocole accepte les treize clients et `other` (`packages/protocol/src/messages.ts`).

## 11. Banc de simulation (D56)

Le banc minimal est **Existant** (T4.1, capacité OpenSpec `simulation`, [rapport](../../openspec/changes/archive/2026-10-10-t4-1-simulation-baseline/proof/report.md)) ; la simulation complète est **Visé** (T4.7).

- **Existant** T4.1 : banc local, relais dédié, 50 nœuds en processus séparés, faux agents déterministes, mesures mémoire et latence, rapport.
- **Visé** T4.7 : 500 nœuds virtuels regroupés, 10 à 20 personnages dans une entreprise fictive sur modèles gratuits, carte interactive, traces, rapport par campagne.
- **Existant** T4.1, **Visé** T4.7, lieu : le Mac, avec un relais dédié ; jamais le VPS ni le relais de production. **Existant** (mesure) : le VPS lab avait 5,6 Gio de swap occupés sur 8 ([simulation][r5]).
- **Visé** T4.7, carte : vue équipe regroupable, vue parcours par demande, lecture et pas à pas, injection de pannes et de sorties piégées. React Flow (xyflow, MIT) est candidat, limité au paquet de simulation.
- **Visé** T4.7, traces : Langfuse et un rapport par campagne. Les événements ne portent que des hash et des métadonnées ; forme proposée dans [le schéma backend](BACKEND_SCHEMA.md#événement-de-simulation).
- **Visé** T4.7, boucle d'amélioration : elle produit des rapports et ajuste seule, en versionnant, les textes, le routage et les consignes des personnages ; jamais le code ni la sécurité.
- **Hypothèse** : 500 nœuds virtuels tiennent dans un seul processus sur le Mac de 16 Go. Critère : mesure RSS et latence en T4.1, puis T4.7.

## 12. Exigences non fonctionnelles

| Domaine        | Cible ou valeur                                                                                                                                         | Statut                                                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Bornes         | Enveloppe 256 Kio, TTL 15 min, décalage 5 min, fenêtre de rejeu 30 min.                                                                                  | **Existant** : `packages/protocol/src/envelope.ts:17-20`.                                                                    |
| Bornes relais  | 60 envois par minute et par Node, file de 100 enveloppes par destinataire, 20 admissions par parrain et par jour.                                      | **Existant** : `packages/relay/src/server.ts:30-34`.                                                                         |
| Performance    | Latence de bout en bout d'un Drop, débit du relais, temps de connexion par mode.                                                                        | Mesure de référence **Existant** T4.1 ([rapport](../../openspec/changes/archive/2026-10-10-t4-1-simulation-baseline/proof/report.md)) ; par mode, à mesurer. Aucun chiffre n'est promis avant mesure.                                            |
| Mémoire        | Node v24 vide : 44 Mo de RSS ; 67 Mo avec libsodium et zod.                                                                                              | **Existant** (mesure, [simulation][r5]).                                                                                     |
| Mémoire        | Nœud complet avec faux agent : 130 à 180 Mo ; 50 processus tiennent sur le Mac, 500 exigent des nœuds regroupés.                                         | **Hypothèse** (inférence). Critère : mesure T4.1.                                                                            |
| Disponibilité  | Reconnexion exponentielle au relais ; file du relais et file hors ligne non durables ; échec visible, sans repli silencieux.                            | **Existant** : [spec node](../../openspec/specs/node/spec.md#requirement-reconnexion-exponentielle-au-relais), `server.ts:134`. Échec expliqué par mode : **Visé** T4.2. |
| Confidentialité | Reçus en hash et métadonnées ; aucune télémétrie ; diagnostic partageable sans contenu.                                                                | **Existant** : `packages/protocol/src/receipt.ts:7-32`, [profil privé](../PRIVATE_PROFILE.md#exploiter-le-relais).          |
| Observabilité  | Codes d'erreur stables (`packages/protocol/src/errors.ts:2-19`), journaux locaux.                                                                       | **Existant**. Traces de simulation : **Visé** T4.7.                                                                          |
| Accessibilité  | Clavier et VoiceOver avant toute décoration (D46).                                                                                                      | Recette VoiceOver réelle **Visé** T3.4 (`blocked`).                                                                          |
| Plateformes    | Mac d'abord, puis Windows et Linux.                                                                                                                      | **Visé** T3.4, T3.7, T3.8.                                                                                                   |

## 13. Dépendances candidates

**Existant** : la stack imposée et la règle d'ajout sont dans [AGENTS.md](../../AGENTS.md#stack-imposée) ; T4.0 n'ajoute aucune dépendance ([proposal](../../openspec/changes/archive/2026-10-10-t4-0-product-docs/proposal.md)).

| Candidat                | Licence           | Usage envisagé                                                   | Statut                                                                       |
| ----------------------- | ----------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| iroh 1.3.0, dans le programme Rust séparé `crates/drop-iroh` | MIT ou Apache-2.0 | Connexion directe et traversée de NAT ([connexion][r2]).         | **Existant** T4.2b, D68. |
| React Flow (xyflow)     | MIT               | Carte de simulation, limitée au paquet de simulation.            | **Visé** T4.7, même règle.                                                    |
| `bonjour-service` 1.4.4 | MIT               | Découverte locale.                                               | **Existant** T4.2, D61. |
| Helm                    | Apache-2.0        | Chart du relais d'entreprise (`deploy/helm/drop-relay`).         | **Existant** T4.10 ; Helm dans la CI **Visé** T4.10c. |

## 14. Questions techniques ouvertes

Chacune est une **Hypothèse** à trancher dans la tâche citée, sauf celles marquées tranchées.

1. Identité iroh : tranchée par D68, la clé iroh est la graine de la clé drop.
2. mDNS sur macOS : permission « réseau local » et comportement en arrière-plan à vérifier dans la doc Apple de la version ciblée. Critère : test T4.2 sur Mac réel.
3. Revérification de la politique par le relais : tranchée par D81, par l'empreinte présentée à l'authentification.
4. Réponse humaine avec fichier : tranchée par D64, 128 Kio au plus, sans découpage.
5. Niveau 2 : `Message` ou `Task` courte selon le délai de consentement. Critère : spec T4.9.
6. Magasin durable des tâches A2A pour le niveau 4. Critère : spec T4.11.
7. Hébergement des traces Langfuse de la simulation, sans toucher au VPS ni au relais de production. Critère : rapport T4.1.
8. Extension de `requestedBy.agent` aux treize clients : faite en T4.5.

[tasks]: ../TASKS.md
[r0]: ../research/2026-10-10-repositionnement.md
[r1]: ../research/2026-10-10-repositionnement.md#1-douleurs-adoption-a2a-et-concurrents
[r2]: ../research/2026-10-10-repositionnement.md#2-connexion
[r3]: ../research/2026-10-10-repositionnement.md#3-interactions-et-contexte-partagé
[r4]: ../research/2026-10-10-repositionnement.md#4-clients-mcp-configuration
[r5]: ../research/2026-10-10-repositionnement.md#5-capacité-de-simulation-mesures-locales
