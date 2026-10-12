# Tasks : stockage anti-rejeu avant pilote (T3.1e)

## 1. Lever les doutes

- [x] 1.1 Lire la doc de Node 24.21 et le source libuv 1.52.1 pour `fsync`, `rename`, `kill(pid, 0)` sous macOS, Linux et Windows, et la doc Microsoft de `FlushFileBuffers` et `MoveFileEx`. **Vérification** : sources citées dans design.md.

## 2. Tests d'abord

- [x] 2.1 Tests de part par pair (stockage et moteur), de coût (une synchronisation, aucun renommage, aucune lecture ni synchronisation de dossier), de partage entre processus, d'enregistrement déchiré, de quarantaine et de verrou mort. **Vérification** : verts après 3.1. Écart au protocole : ces tests ont été écrits après le code, sans phase rouge ; les mutations de 2.3 servent de preuve qu'ils détectent un ordre d'écriture fautif.
- [x] 2.2 Injection de panne à chaque synchronisation (compaction, première admission, migration, fin de quarantaine), comptes par système. **Vérification** : comptes 2, 9 et 7 sous macOS et Linux, 2, 5 et 4 sous Windows.
- [x] 2.3 Injection de crash à chaque appel mutant du système de fichiers (une écriture à moitié faite), cinq scénarios. **Vérification** : 12, 15, 42, 42 et 39 points sous macOS ; une mutation (vider l'ancien journal avant d'écrire le nouveau) fait échouer deux tests.

## 3. Réalisation

- [x] 3.1 `replay-store.ts` : journal, index, compaction, migration, quarantaine, verrou ; `durable.ts`. **Vérification** : tests de 2.x verts.
- [x] 3.2 `engine.ts` : pair passé à `claimDrop`, `peer_quota` et causes `replay_peer_quota` / `replay_capacity`. **Vérification** : tests moteur verts.
- [x] 3.3 Guides : `PRIVATE_PROFILE.md`, `BACKEND_SCHEMA.md`, `TRD.md`. **Vérification** : relecture.

## 4. Vérifier et clore

- [x] 4.1 `pnpm -r lint && pnpm -r typecheck && pnpm -r test`, fichiers anti-rejeu répétés. **Vérification** : proof/verification.md.
- [x] 4.2 openspec-guard `--fail-on fail`, puis `--update-baseline` (retraits seulement).
- [x] 4.3 Revue (`review`) et audit (`cso`) du diff. **Vérification** : proof/verification.md.
- [x] 4.4 Archive de la change dans la même PR.
