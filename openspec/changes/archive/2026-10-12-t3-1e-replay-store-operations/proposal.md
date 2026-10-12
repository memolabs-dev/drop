# Proposal

## Why

T3.1e ferme les suites de T3.1b et T3.1c sur le stockage anti-rejeu avant un pilote (`proof/state.json` de T3.1b : « T3.1e owns per-peer marker quota, admission cost, crash recovery between marker and digest, Windows rename durability » ; constat CSO moyen de T3.1c : aucune part par pair).

1. **Part par pair.** Un pair appairé disposant d'un chemin direct rapide peut remplir les 16 384 marqueurs et faire refuser tous les autres pendant 30 minutes.
2. **Coût par demande.** Chaque admission relisait tout le dossier des marqueurs, hachait la liste triée et faisait six synchronisations (trois fichiers, trois dossiers) : 101 ms par admission sur un Mac sur un stockage presque vide, 45 ms à 16 000 identifiants.
3. **Reprise.** Un crash entre la création d'un marqueur et l'écriture de son empreinte bloquait toute admission jusqu'à une réparation manuelle ; un verrou laissé par un processus mort aussi ; toute perte d'état imposait une nouvelle identité.
4. **Windows.** T3.7 saute la synchronisation de dossier, que Windows refuse. Le renommage qui publiait l'horloge et l'empreinte n'était donc pas durable au retour de l'admission en cas de coupure de courant.

## What Changes

- Format 3 du stockage : deux journaux d'enregistrements de taille fixe (identifiant, étiquette hachée du pair, horloge), un seul valide à la fois. Une admission ajoute un enregistrement et synchronise ce fichier : une synchronisation, aucun renommage, aucun dossier. Un index en mémoire, prouvé à jour par les en-têtes et tailles sous le verrou, répond aux demandes.
- Part de 1 024 identifiants vivants par pair, `E_RATE` avant accord, journalisée `replay_peer_quota` ; saturation globale journalisée `replay_capacity`.
- Reprise après crash sans intervention ; reprise d'un verrou dont le propriétaire est prouvé mort ; quarantaine de 35 minutes au-delà de la plus haute horloge connue après une perte d'état, puis redémarrage sûr.
- Migration à la première admission depuis les formats 1 et 2, avec toutes les vérifications de T3.1b.

## Non-goals

- Pas de part par pair pour `ReplayCache` ni pour la boîte d'approbation (constat CSO de T3.1c, hors de cette ligne).
- Pas de détection d'une restauration d'une copie plus ancienne et cohérente du journal (limite déjà documentée en T3.1b pour un instantané).
- Pas de nouvelle dépendance, ni de verrou du système (Node n'en expose pas).

## Capabilities

### Modified Capabilities

- `node` : stockage anti-rejeu persistant, nettoyage et panne passagère ; nouvelles exigences sur la part par pair, le coût et la durabilité, l'index partagé, la reprise après crash, le verrou abandonné et la quarantaine.

## Impact

`packages/node/src/replay-store.ts` (nouveau), `durable.ts` (nouveau, helpers déplacés de `home.ts`), `home.ts`, `engine.ts` (pair passé à `claimDrop`, causes journalisées), leurs tests, `docs/PRIVATE_PROFILE.md`, `docs/product/BACKEND_SCHEMA.md`, `docs/product/TRD.md`. Le format sur disque change ; une version antérieure refuse le format 3.
