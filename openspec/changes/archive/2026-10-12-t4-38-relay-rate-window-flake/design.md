# Design : le test de rétablissement après la fenêtre de cadence tient sous charge

## Context

Voir proposal.md pour la cause et les mesures. Trois horloges interviennent dans ce test :

| Horloge | Avant | Après |
| --- | --- | --- |
| fenêtre de cadence du relais (`now`) | injectée (`clock.now`) | inchangée |
| pinger du relais (balayage, 20 ms) | `setInterval` réel | simulé, avancé par le test |
| reconnexion du client (reprise, TCP, défi) | réelle, attendue par un délai fixe de 60 ms | réelle, attendue par événement |

## Decisions

### Attendre la reconnexion, pas un délai

`until(() => statuses.includes('disconnected'))` puis `waitReady()`. Le statut `disconnected` est poussé par `lost()`
après que `ready` est passé à faux ; `waitReady()` attend donc le `ready` de la nouvelle connexion. Le délai de 3 s de
`until` est celui de l'assistant du fichier, utilisé par les autres tests, et ne borne que l'arrivée de la fermeture.

### Simuler seulement les intervalles

`toFake: ['setInterval', 'clearInterval']`. Le pinger et le battement de cœur du client sont des `setInterval` ; tout
le reste (sockets, `setTimeout` de la reprise, de l'authentification et des acquittements) garde le temps réel, sans
quoi la reconnexion ne se ferait plus. Le battement de cœur du client (15 s par défaut) ne tourne jamais pendant le
test ; le pinger tourne une fois, quand le test l'avance de 20 ms. `vi.useRealTimers()` est rangé en premier dans
`cleanups`, donc rétabli en dernier, après la fermeture du relais et du client.

### Choix écartés

- **Allonger l'attente** (200 ms, 1 s) : réduit la fréquence sans supprimer la course, et D101 l'interdit sans cause
  mesurée.
- **Ne pas fermer après `E_RATE`** : contredit la spec du relais.
- **Simuler tous les temporisateurs** avec `shouldAdvanceTime` (comme `client-liveness.test.ts`) : le pinger
  repasserait au rythme du temps réel et le balayage redeviendrait une course.

## Risks / Trade-offs

- **Le balayage n'est pas observable de l'extérieur** : le test garantit qu'il a lieu (vérifié par instrumentation
  temporaire, une seule passe, `sentByNode` passe de 1 à 0 entrée) et qu'il ne casse pas le rétablissement, mais il
  passerait aussi si le balayage était retiré, puisque `charge` élague déjà la fenêtre de l'expéditeur. C'était déjà le
  cas avant ; le rendre observable demanderait d'exposer l'état du relais, hors périmètre.
