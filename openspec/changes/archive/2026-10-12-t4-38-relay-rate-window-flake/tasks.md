# Tasks : le test de rétablissement après la fenêtre de cadence tient sous charge

Aucune logique de produit n'est touchée. Le test garde son titre et ses quatre assertions.

## 1. Cause

- [x] 1.1 Reproduire sous charge (12 vitest en parallèle, 10 boucles actives). **Vérification** : 4 échecs sur 72 puis
      31 sur 144, tous `expected 'offline' to be 'queued'` ligne 285.
- [x] 1.2 Reproduire de façon déterministe : attente de 15 ms, sous la reprise de 20 ms. **Vérification** : 5 échecs
      sur 5, même message.

## 2. Test

- [x] 2.1 Attendre `disconnected` puis `waitReady()` au lieu de 60 ms ; simuler `setInterval` et avancer le pinger
      d'un tour après l'horloge injectée. **Vérification** : le test passe en local.
- [x] 2.2 Mutation : fenêtre de cadence dix fois plus longue dans `server.ts`. **Vérification** : le test échoue
      (`expected 'E_RATE' to be 'queued'`).
- [x] 2.3 Reprise du client portée à 150 ms, au-delà de l'ancien délai de 60 ms. **Vérification** : le test passe.
- [x] 2.4 Instrumentation temporaire du balayage. **Vérification** : une seule passe, `sentByNode` de 1 à 0 entrée.

## 3. Preuve sous charge

- [x] 3.1 Même charge qu'en 1.1. **Vérification** : 0 échec sur 72 puis 0 sur 144 (charge moyenne 19 à 45) ; fichier
      entier 24 passages sur 24 (40 tests chacun) sous la même charge.
