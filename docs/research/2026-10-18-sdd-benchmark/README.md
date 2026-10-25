# Drop — benchmark Spec-Driven Development (Issue #118)

**Date :** 18 octobre 2026. **Nature :** audit comparatif reproductible, sans modification de
l'application. **Base figée :** `memolabs-dev/drop@351672c800520520dca075804a329e77bc28be53`.
**Issue :** [Drop #118](https://github.com/memolabs-dev/drop/issues/118).

## Résumé

La tâche d'origine **T4.25 est déjà terminée** dans `docs/TASKS.md` depuis le 12 octobre 2026,
via la [PR #68](https://github.com/memolabs-dev/drop/pull/68). Ce benchmark ne prétend donc pas
corriger une seconde fois le test SIGTERM. Il compare la façon de représenter ses exigences,
ses tâches, leur exécution et leurs preuves selon trois approches.

**Décision provisoire :** conserver **OpenSpec** pour les contrats normatifs et leurs
marqueurs de couverture ; utiliser **Memo Bridge/Beads** pour l'orchestration et les dépendances.
La structure **Spec Kit** est une alternative documentaire utile mais dupliquerait les
requirements dans ce dépôt si elle devenait normative. Aucune supériorité de vitesse ou de
fiabilité entre frameworks n'a été mesurée.

## Un même contrat, trois méthodes

La seule source normative est
[`openspec/specs/simulation/spec.md`](../../../openspec/specs/simulation/spec.md),
scénario `AC: aucun processus orphelin`. Il est lié au test exact
`simulation bench signals (T4.1) > AC stops every process it started when the bench receives SIGTERM mid-campaign`
par `openspec-guard:test`.

**WHEN** le banc reçoit SIGTERM après la mise en charge,
**THEN** le relais et tous les nœuds qu'il a lancés sont terminés.
Les quatre invariants du test : au moins trois enfants observés (relais, propriétaire,
demandeur), aucun enfant encore vivant après l'arrêt, sortie anticipée signalée avec stderr,
et nettoyage garanti même après une erreur. Le test Windows est exclu car son SIGTERM diffère.
Aucune destination réseau de production, aucun secret réel ou changement de logique du produit.

| Approche | Entrée | Traçabilité vers l'AC | Exécution | Limite |
| --- | --- | --- | --- | --- |
| **OpenSpec (réel)** | Proposal, design, tasks T4.25 archivés | Scénario canonique → marqueur `openspec-guard` → Vitest → PR #68 | Memo Bridge ou agent au choix | Ne gère pas seul les claims multi-agents |
| **Spec Kit (projection)** | Requirements, plan, tasks (voir `variants.md`) | Référence au scénario OpenSpec, jamais copie normative | Même worker/tests | Fichiers redondants si les requirements sont copiés |
| **Beads + Memo Bridge (partiellement réel)** | Issue #118, dépendances et checks | `contract_ref` → test → receipt | Claim → worktree VPS → jobs → PR | Graphe de tâches insuffisant sans spec |

Le format Spec Kit et le graphe Beads sont **des transpositions de référence, pas des CLI
exécutées** dans ce pilote. Memo Bridge a réellement réservé la tâche et lancé les jobs.

## Résultats observés : nouvelle baseline sur VPS

Un run complet sur le commit de base, **avant changement de code**, a été lancé via
Memo Bridge dans un worktree Drop autorisé sur le VPS.

| Run | Identifiant | Résultat |
| --- | --- | --- |
| `npm test` → `vitest run` | `job_woq2MPJIDbjk2q_N` | **Exit 1** ; 825 tests passent, 5 échouent, 7 ignorés ; 21 erreurs ; durée Vitest **253,40 s** |
| `npm run lint` | `job_4EhwcBQNbkGRl2T9` | **Exit 0** ; ESLint et Prettier verts |
| Lint après mise à jour des preuves | `job_jVrVpX1ZrECVwe04` | **Exit 0** ; ESLint et Prettier verts |

Le run Vitest s'est déroulé de **15:03:19 à 15:07:40 UTC**. Le journal signale notamment
`SystemError: uv_interface_addresses returned Unknown system error 97` dans
`packages/node/test/private-system.test.ts`, lors de l'utilisation de `multicast-dns`
et `os.networkInterfaces()` dans le sandbox réseau du VPS. Les cinq échecs ne sont pas tous
attribuables à cette exception sans revue de logs complète. On **ne prétend ni que la suite
est verte, ni que le scénario SIGTERM isolé est passé** : ce dernier n'a pas été exécuté
séparément dans ce pilote.

Le test Vitest a aussi régénéré `packages/node/src/workspace-assets.generated.ts` dans son
worktree. Le rapport est publié depuis **un second worktree propre**, créé à partir du même
commit, pour ne pas intégrer cet artefact accidentel. Pas de modification produit.

## Verdict Mac : scénario isolé et suite complète

Deuxième environnement, même base, mesuré le 18 octobre 2026 sur le Mac du propriétaire
(Mac16,12, 10 processeurs, 16 Go, Node 24.21.0, Vitest 5.0.3), sur `c58949c`, la tête de
cette branche au-dessus de `351672c8`. C'est l'environnement que l'action 2 désignait.

### Scénario SIGTERM seul, puis sous charge

`npx vitest run packages/simulation/test/campaign.test.ts -t SIGTERM`

| Exécution | Résultat | Durée du test |
| --- | --- | --- |
| Isolé, 3 fois | 3 réussites sur 3 | 2,91 s ; 2,98 s ; 3,05 s |
| Trois suites concurrentes, 3 tours, 9 exécutions | 9 réussites sur 9 | 3,34 s à 3,64 s |
| Suite complète, 122 fichiers en parallèle | 1 réussite sur 1 | **4,81 s** |

Aucune anomalie d'environnement observée, ni dans les 12 exécutions ciblées ni dans les
deux passages de la suite complète. Le flake n'est pas reproduit : ni seul, ni sous trois
copies concurrentes, ni sous la charge de la suite entière. Le coût de la concurrence est
réel mais modeste (environ 3,0 s seul, 3,5 s à trois, 4,81 s dans la suite), très loin du
dépassement de 60 s mesuré avant la PR #68.

### Suite complète : les échecs du VPS sont environnementaux

| Environnement | Commande | Résultat | Durée |
| --- | --- | --- | --- |
| VPS (sandbox réseau) | `npm test` | Exit 1 ; 825 réussites, 5 échecs, 7 ignorés | 253,40 s |
| Mac | `pnpm test` | **Exit 0** ; 836 réussites, 0 échec, 1 ignoré | 84,75 s |

C'est le même ensemble de 837 tests. Les cinq échecs du VPS passent sur le Mac, et six des
sept tests ignorés y sont exécutés (conditions de plateforme). Aucune trace de
`uv_interface_addresses` ni d'`ENOENT` : ces échecs s'expliquent par le sandbox réseau, pas
par le code. Un second passage en rapporteur JSON confirme `success: true`, 836 réussites,
0 échec, 1 ignoré, et le test SIGTERM à l'état `passed` en 4,81 s sur un fichier mesuré à
15,75 s.

### Lint, typecheck et artefacts

- `pnpm lint` : exit 0 en 10 s (ESLint sans avertissement, Prettier conforme).
- `pnpm typecheck` : exit 0 en 2 s.
- La suite régénère `packages/node/src/workspace-assets.generated.ts`. Cet artefact n'est
  pas inclus dans la branche, comme pour le run VPS.

**Verdict sur T4.25 : stable sur le Mac dans les conditions mesurées.** La limite reste la
charge : trois copies concurrentes et la suite de 122 fichiers, pas 79 fichiers pilotés
séparément. Ce constat ne remplace pas la revue du correctif de la PR #68, et il ne mesure
aucune différence entre les trois méthodes comparées.

### Mesures historiques — source PR #68, le 12 octobre (distinctes de celles du jour)

- Diagnostic initial : test seul 12 s ; les démarrages à froid augmentaient fortement sous
  charge CPU, tandis que les appairages restaient autour de 3,5–4,1 s.
- Ancien test sous trois suites concurrentes : un échec reproduit et une copie à 58 s,
  proche de son ancien timeout de 60 s.
- Après correction : 5 suites complètes réussies sur 5, test en **5,4–6,6 s** ; et 6 copies
  sur 6 sous trois suites concurrentes, test en **14,6–28,0 s**.
- Le correctif historique a réduit de 3 à 2 nœuds (en conservant les 3 types), augmenté la
  phase d'attente à 120 s et le test à 150 s, capté `exit` et sécurisé le `finally`.

Ces chiffres sont une preuve de **l'ancien correctif**, **pas** d'un gain OpenSpec vs Spec Kit
vs Beads. Un benchmark impartial exige des tâches neuves et des exécutions comparables.

## Comparabilité et limites

Les critères des trois variantes sont identiques : invariant conservé, AC→test→preuve,
détection de dérives, dépendances explicites, reprise multi-agent, interventions humaines,
temps jusqu'à une PR validée, tokens et coûts (seulement si réellement instrumentés).
Pour un futur comparatif : trois branches depuis le même commit, trois essais réellement
indépendants et comparables, même modèle/budget/CI, répétitions sous charge contrôlée.

Ce pilote **ne mesure pas** les tokens par méthode, le temps de développement comparé, ni
l'effet causal des frameworks. Sa valeur vérifiable est la **trace des exigences et des
contrôles**. Les données VPS restent limitées par le sandbox réseau.

## Actions suivantes et garde-fous

1. Ne pas rouvrir T4.25 : il est `done`. La suite de simulation est suivie par T4.42,
   tâche distincte et hors périmètre de #118.
2. **Fait le 18 octobre** : classer les échecs Vitest sur un environnement adapté, notamment
   réseau/mDNS, et exécuter le scénario SIGTERM isolé sur Mac. Voir la section « Verdict
   Mac » : suite verte en 84,75 s, test SIGTERM vert 12 fois sur 12 en ciblé et 4,81 s sous
   la charge complète, aucun des cinq échecs VPS reproduit.
3. Conserver la source normative OpenSpec ; enrichir Beads/Memo Bridge avec des références
   obligatoires `contract_ref`, `test_ref`, `evidence_ref`.
4. Ne pas fusionner ou déployer ce benchmark sans revue.
   [Memo Bridge #184](https://github.com/memolabs-dev/memo-bridge/pull/184) a été fusionnée
   le 18 octobre 2026 (`a018f88`) et `drop` est enrôlé sur le runtime Mac : 24 projets
   autorisés, un projet hors liste restant refusé avec un message qui nomme le runtime qui
   répond.

**Verdict : OpenSpec + Memo Bridge/Beads pour Drop ; Spec Kit comme format comparatif, pas
comme deuxième source normative.** C'est une décision d'intégration, pas un score de performance.
