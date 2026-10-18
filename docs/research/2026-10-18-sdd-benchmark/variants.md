# Représentations comparées — scénario SIGTERM T4.25

**Autorité unique** : `openspec/specs/simulation/spec.md` et son scénario
`AC: aucun processus orphelin`. Chaque représentation ci-dessous est une **projection
non normative** et ne modifie pas la spec existante.

## A. OpenSpec réel

Les artefacts sont déjà livrés dans
`openspec/changes/archive/2026-10-12-t4-25-simulation-signal-flake/`.

- `proposal.md` : problème observé, reproduction à forte charge, chiffres et non-objectifs.
- `design.md` : causalité (démarrages à froid), stratégie, délais, risques et alternatives.
- `tasks.md` : reproduction, test qui échoue si `stopAll` est supprimé, validations.
- `.openspec.yaml` : `skip_specs: true` puisque la propriété normative est inchangée.
- `openspec-guard` : sélecteur du test exact attaché à l'AC.

**Ce qu'un agent doit produire :** un diff isolé + exécution + preuve avant PR, pas une
deuxième spécification du signal.

## B. Spec Kit — projection du même travail, pas une installation

### spec.md (requirements projetés)

- **R1 MUST** : SIGTERM une fois `requesters paired` termine tous les enfants observés.
- **R2 MUST** : la sortie anticipée du banc échoue immédiatement avec diagnostic.
- **R3 MUST** : cleanup sur succès et erreur, après la fin du banc.
- **R4 SHOULD** : test viable sous forte charge, sans remplacer l'exigence par un simple timeout.
- **Test de conformité** : l'AC OpenSpec canonique et son test existant ; aucune recopie
  du contrat dans `openspec/specs/`.

### plan.md (plan projeté)

Reproduire → mesurer les démarrages à froid → choisir une réduction équivalente des cas →
tester l'arrêt et une mutation volontaire de `stopAll` → lint, Vitest, CI, revue.

### tasks.md (tâches projetées)

1. Collecter une baseline sous charge, avec durée, erreurs et environnement.
2. Démontrer que les trois types de processus sont présents.
3. Ajuster **uniquement le test** si nécessaire, avec timeouts justifiés.
4. Vérifier les chemins de sortie précoce et de `finally`.
5. Fournir un reçu AC → test → job → commit → PR, et classer les échecs externes.

Cette représentation est comparable au workflow OpenSpec T4.25, mais introduirait
des documents supplémentaires si on la maintenait parallèlement dans Drop.

## C. Beads / Memo Bridge — graphe de dépendances projeté

```text
Issue drop#118
  ├─ D1 : relire T4.25 et l'AC canonique
  ├─ D2 : baseline au même commit (après D1)
  ├─ D3 : projection de trois méthodes (après D1)
  ├─ D4 : matrice AC → test → preuve (après D2 et D3)
  └─ D5 : revue + PR (après D4)
```

```yaml
issue: memolabs-dev/drop#118
branch: bench/118-sdd-report-clean
contract_ref: openspec/specs/simulation/spec.md#AC-aucun-processus-orphelin
test_ref: packages/simulation/test/campaign.test.ts
historical_fix: memolabs-dev/drop#68
depends_on: [T4.25]
evidence_ref: docs/research/2026-10-18-sdd-benchmark/README.md
completion_gate: review_required
```

Le claim de #118 et les jobs dans un worktree ont été réellement exécutés par Memo Bridge.
**Aucune CLI Beads n'a été lancée** pour prétendre mesurer son propre coût ou comportement.

## Grille qualitative

| Dimension | OpenSpec | Spec Kit projeté | Task-first |
| --- | --- | --- | --- |
| AC normative unique | Native et présente | Oui si référence, pas copie | Oui si `contract_ref` |
| Preuve historique T4.25 | Archive réelle | À référencer | À référencer |
| Claims et branches isolées | Externe | Externe | Memo Bridge réel |
| Besoin de docs nouvelles pour Drop | Aucun pour T4.25 | Plusieurs | Champs et liens |
| Comparaison chiffrée de vitesse | Non mesurée | Non mesurée | Non mesurée |

**Conclusion structurelle :** OpenSpec spécifie ; Memo Bridge/Beads organise ; les tests et
la CI prouvent. Aucune des trois couches ne dispense des autres.
