# T4.38 : le test de rétablissement après la fenêtre de cadence tient sous charge

## Why

« restores a sender once its rate window has passed, with idle windows swept » (`packages/relay/test/relay.test.ts`)
échouait sous forte charge parallèle : 3 fois sur 72 passages en T3.1f. Reproduit le 12 octobre 2026 en local
(macOS, 10 cœurs), même message à chaque fois, ligne 285, troisième envoi :

| Passages | Charge | Échecs | Message |
| --- | --- | --- | --- |
| 72 | 12 vitest en parallèle, 10 boucles actives, charge moyenne 16 à 19 | 4 | `expected 'offline' to be 'queued'` |
| 144 | idem, charge moyenne 18 à 39 | 31 | `expected 'offline' to be 'queued'` |

La cause n'est pas la fenêtre de cadence : son horloge est déjà injectée (`now`), le relais compte avec `clock.now`
et non avec le temps réel. La cause est la reconnexion.

1. Le relais ferme la connexion après un refus `E_RATE` (exigence « Refus de quota sans identifiant corrélable »,
   `server.ts`, `CLOSE_RATE`). Le deuxième envoi du test ferme donc la connexion de l'expéditeur.
2. Le client se reconnecte après son délai de reprise (20 ms dans les tests), rouvre TCP, reçoit un défi, le signe
   (Ed25519) et le relais vérifie la signature avant `ready`.
3. Le test attendait 60 ms de temps réel puis envoyait. Quand la reconnexion prend plus de 40 ms au-delà de la reprise,
   le client n'est pas prêt et `send` rend `offline` sans rien envoyer.

Reproduction déterministe : avec une attente de 15 ms au lieu de 60 (inférieure à la reprise de 20 ms), le test échoue
5 fois sur 5 avec le même message. Le même défaut touchait le balayage : le pinger du relais (20 ms en temps réel)
pouvait ou non avoir tourné avant le troisième envoi, de sorte que « with idle windows swept » n'était pas garanti.

## What Changes

- Le test attend la reconnexion qu'il provoque : `disconnected` dans les statuts du client, puis `waitReady()`, au
  lieu d'un délai fixe.
- Les intervalles (`setInterval`, `clearInterval`) sont simulés pour ce seul test (`vi.useFakeTimers`, vitest 5.0.3) :
  après avoir avancé l'horloge injectée de 60 001 ms, le test fait tourner le pinger une fois
  (`vi.advanceTimersByTime(20)`). Le balayage des fenêtres inactives a donc lieu exactement une fois, après
  l'expiration de la fenêtre et avant le troisième envoi. Sockets, `setTimeout` et `Date` restent réels.
- Les quatre assertions sont inchangées : `queued`, `E_RATE`, puis `queued` après la fenêtre, puis `E_RATE` à nouveau.

## Capabilities

Aucun contrat ne change, donc `skip_specs: true`. La capacité concernée est `relay`, exigence « Limite de débit par
Node ». Le test n'est le marqueur d'aucun scénario ; il garde son titre.

## Non-goals

- **Aucun délai allongé** (D101) : le délai fixe disparaît, remplacé par l'attente de l'événement.
- **Pas de changement du relais ni du client** : fermer après `E_RATE` est exigé par la spec, et se reconnecter après
  une reprise est le comportement voulu du client. Le défaut est dans le test.
- **Pas la vivacité du client** (`ackTimeoutMs`, battement de cœur) : T4.39.

## Impact

- `packages/relay/test/relay.test.ts` seulement.
- Aucune dépendance, aucun schéma, aucun contrat.
