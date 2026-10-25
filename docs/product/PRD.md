# PRD : drop

Document descriptif. Les contrats normatifs vivent dans `openspec/specs` ; l'ordre dans `docs/TASKS.md` ; les décisions dans `docs/DECISIONS.md`.

`openspec/project/vision.md` en est le résumé et `PRODUCT.md` le brief de conception du panneau (mise en vérité T4.0a). En cas de contradiction, ce PRD et D47 à D58 font foi.

**Statuts utilisés.** **Existant** : livré, avec un chemin ou une preuve. **Visé** : à livrer, avec la tâche qui le porte. **Hypothèse** : non validée, avec le critère qui la confirmera ou l'invalidera. Rien n'a encore été validé avec de vrais utilisateurs : Julie et Natha sont des scénarios, toutes les démonstrations ont tourné sur les machines de Guillaume.

## 1. Le problème

Un agent a besoin d'une information qui vit dans les outils d'un collègue : l'état d'une maquette Figma, un ticket Linear, une page Notion, une requête sur une base. Aujourd'hui, deux voies :

1. Écrire au collègue sur Slack et attendre, parfois des heures.
2. Lui demander ses accès (jeton API, invitation à l'outil) pour que l'agent aille lire lui-même.

La première est lente. La seconde donne bien plus que la réponse : l'agent du demandeur peut tout lire, et l'accès reste ouvert. Les études de 2026 placent cette seconde voie au premier rang des incidents : 53 % des organisations ont vu des agents dépasser leurs permissions, et les identifiants partagés en sont la cause la plus citée ([recherche §1](../research/2026-10-10-repositionnement.md#1-douleurs-adoption-a2a-et-concurrents), études financées par des éditeurs).

**Hypothèse H1.** Ce blocage coûte assez de temps pour qu'une équipe change d'outil. Critère : le seuil D24 (au moins 3 développeurs, 10 jours actifs chacun, au moins 0,5 blocage par développeur et par jour, médiane d'au moins 10 minutes perdues). Statut : non mesuré ; la seule base observée, celle de Guillaume, contient 4 événements classés, tous « pas un blocage » (D25 explique pourquoi un travailleur seul ne bloque que sur sa propre infrastructure).

Problèmes suivants, dans l'ordre (D47) :

1. Un responsable veut l'avancée réelle de l'équipe sans réunion.
2. Une personne non technique, dans ChatGPT ou Claude, veut interroger le travail de ses collègues.
3. Deux organisations veulent faire travailler leurs agents ensemble.

## 2. La promesse

**« La réponse, pas l'accès. »** L'agent pose une question bornée. Le propriétaire de la source voit qui demande, quoi, pourquoi, ce qui partira et ce qui ne partira jamais. Il autorise une fois, refuse, ou reporte. Seule la réponse validée revient.

Promesse publique (D52) : « Tes données restent sur ta machine. Seule une réponse que tu as approuvée en sort, chiffrée, vers la personne qui l'a demandée. Aucun index central, aucun serveur qui lit, code ouvert et journal local de tout ce qui est sorti. »

**Limite, toujours affichée avec la promesse.** drop contrôle ce qui passe par drop. Un connecteur MCP ou un modèle choisi par le propriétaire peut avoir ses propres flux, que drop ne voit pas.

## 3. Positionnement

| | drop | Le marché étudié |
|---|---|---|
| Ce qui est contrôlé | le contenu qui sort | l'accès à un outil |
| Qui décide | le propriétaire, demande par demande | une politique ou un administrateur |
| Où vit la donnée | chez son propriétaire | indexée ou lue par l'agent du demandeur |
| Hébergement | sur les machines de l'équipe, sans serveur imposé | souvent SaaS, ou licence entreprise |

Produits proches et leur différence (sources : [recherche §1](../research/2026-10-10-repositionnement.md#concurrents-proches)) :

- **Glean** : serveur MCP managé qui respecte les permissions, en SaaS.
- **agentgateway** (Apache-2.0) : passerelle LLM, MCP et A2A avec contrôle d'accès par rôle.
- **Preloop, withHuman, Impri** : approbation humaine par appel d'outil, puis l'agent lit la donnée.
- **Microsoft Agent 365 et Entra Agent ID** : registre d'agents et approbation administrateur.
- **Gemini agent (Google, annoncé le 8 octobre 2026)** : agent d'entreprise qui se connecte à des serveurs MCP internes et externes, avec identité par agent, droits par rôle, Agent Gateway et journal d'audit ; l'administrateur décide de l'accès ([annonce](https://cloud.google.com/blog/products/ai-machine-learning/welcome-to-gemini-at-work-2026)).

**Hypothèse H2.** Aucun produit ne fait valider le contenu sortant par son propriétaire. Critère : revue concurrentielle refaite avant le lancement, inscrite dans le périmètre de T4.13. Statut : inférence de la recherche du 10 octobre 2026.

drop ne concurrence pas A2A : il l'implémente et s'y place comme couche de consentement humain. A2A v1.0 est stable depuis mars 2026 et gouverné par l'AAIF ; l'autorisation fine, la délégation et l'audit restent ouverts dans le protocole ([recherche §1](../research/2026-10-10-repositionnement.md#a2a)).

## 4. Pour qui

Décision D48.

| Rôle | Qui | Ce qu'il fait | Statut |
|---|---|---|---|
| Premier utilisateur | Guillaume | utilise drop au quotidien | Existant (démos sur ses machines) |
| Testeurs | 3 à 5 développeurs pour la mesure D24, puis au moins deux binômes de collègues dans des contextes différents (D83) | mesure du besoin, puis essai réel en P1 | Visé (T0.7, T4.6) |
| Demandeur | développeur avec un ou plusieurs agents | pose les questions | Visé en usage réel |
| Propriétaire | technique ou non, avec ou sans agent | décide et répond | Visé en usage réel |
| Responsable | veut l'avancée de l'équipe | pose des questions à plusieurs | Existant en code (T2.10, T2.12), jamais utilisé en vrai |
| Administrateur | informatique d'une grande entreprise | déploie le relais interne et la politique | Existant en code (T4.10), jamais utilisé en vrai |

**Référence de conception.** Une grande entreprise souveraine : un ingénieur d'un grand compte industriel rapporte que son entreprise utilise A2A et veut zéro dépendance externe, un outil installé en interne, avec protection des données. Chaque choix technique doit rester acceptable pour une telle équipe informatique.

**Adoption.** Par les petites équipes et les PME, qui décident vite. Aucun revenu n'est attendu des grands comptes au départ.

**Hypothèse H3.** Un propriétaire non technique comprend la carte de décision et décide correctement sans documentation. Critère proposé : sur cinq personnes non techniques, au moins quatre expliquent sans aide ce qui partira et ce qui ne partira jamais (T4.6). Statut : non testé ; la compréhension humaine manque déjà dans T1.14.

**Hypothèse H4.** Le cas rapporté par cet ingénieur représente une demande réelle des grandes entreprises. Critère proposé : au moins une équipe informatique d'un grand compte accepte une démonstration du mode entreprise et formule des exigences écrites. Statut : un seul témoignage, rapporté.

## 5. Ce que fait le produit

### 5.1 L'échelle des échanges (D50)

| Niveau | Nom | Ce qui se passe | Statut |
|---|---|---|---|
| 1 | Fait publié | Le propriétaire marque une information comme partageable ; elle est servie telle quelle, sans modèle, jusqu'à son expiration. | Existant (T4.4) |
| 2 | Petite question | Un modèle répond dans un appel neuf, sans outil, à partir d'un contexte que le propriétaire a déclaré partageable. Jamais depuis la session en cours de son agent. | Visé (T4.9) |
| 3 | Capacité | Outils, budget et approbateur fixés avant la demande ; sortie validée par schéma puis scannée. | Existant (`packages/runner`, `packages/capabilities`, specs `runner` et `capability-*`) |
| 4 | Tâche déléguée | Tâche longue avec jalons où le propriétaire approuve, budget plafonné, expiration, nouvelle approbation si le périmètre s'élargit. | Visé (T4.11) |
| 5 | Conversation libre | Exclue. Les études mesurent jusqu'à 88 % d'attaques de confidentialité réussies et 68,8 % de fuite dans les messages entre agents ([recherche §3](../research/2026-10-10-repositionnement.md#3-interactions-et-contexte-partagé)). | Exclu |

### 5.2 Le propriétaire sans agent (D49)

- **Réponse à la main** : la question arrive dans le panneau, le propriétaire répond par un texte ou un fichier, avec le même consentement et le même reçu. Existant (T4.3).
- **Agent inclus** : le propriétaire branche ses outils dans l'app et laisse drop répondre pour lui après accord, avec un modèle qu'il choisit. Visé (T4.8).

### 5.3 Le contexte partagé décentralisé (D51)

Chaque fait reste chez son propriétaire, signé, daté, avec son public. Seul un catalogue de sujets sans contenu circule pour savoir à qui demander. Personne n'écrit chez un autre : une proposition passe par une boîte de suggestions que l'humain valide. Visé (T4.12).

Limites écrites : une réponse livrée ne se rappelle pas ; le catalogue révèle qui sait quoi ; plusieurs réponses partielles peuvent s'agréger ; l'approbation peut devenir un réflexe. Le RAG central reste exclu.

### 5.4 Brancher les agents (D55)

drop est un serveur MCP standard. La détection déterministe doit couvrir treize clients avec leurs configurations globales et par projet ; les autres reçoivent une configuration à copier. Aucun modèle ne fouille la machine.

- Existant : treize clients détectés ; sept raccordés automatiquement en deux confirmations (Claude Code, Claude Desktop, Cursor, Codex, Gemini CLI, VS Code, Cline), six par une configuration à copier (OpenCode, Devin Desktop ex-Windsurf, Zed, goose, Roo Code, JetBrains AI). T3.3 et T4.5, `packages/node/src/onboarding.ts`, `packages/capabilities/src/clients.ts`. Emplacements : [recherche §4](../research/2026-10-10-repositionnement.md#4-clients-mcp-configuration).
- ChatGPT n'accepte qu'un serveur distant en HTTPS. La passerelle publique (T2.13) n'est pas livrée : c'est une option cloud différée, refusée par le profil privé. Le code existe (`packages/gateway`) ; une politique d'entreprise peut déjà interdire toute passerelle (D54, T4.10).

### 5.5 Se connecter (D53)

| Mode | Pour qui | Comment | Statut |
|---|---|---|---|
| Réseau local | même bureau | découverte automatique, aucun serveur | Existant (T4.2) |
| Internet | amis, petite équipe | iroh, programme Rust séparé embarqué dans l'app (`crates/drop-iroh`) | Existant (T4.2b) |
| Entreprise | informatique interne | relais drop interne en Docker ou Helm, TLS sur 443 | Existant (T4.10) ; binaire autonome Visé (T4.10b) |

Par défaut, aucun relais de secours. Pour Internet, le panneau propose : désactivé, relais iroh auto-hébergé ou d'équipe, ou relais de test d'un tiers (n0) signalé comme tel et refusé en profil privé (T4.2b, D68). Sans relais, deux pairs derrière un routeur ne se joignent pas. Un relais de Memo Labs sur demande d'une équipe reste une hypothèse. Le chiffrement de bout en bout reste actif dans tous les modes. **Hypothèse H5** : environ 90 % de connexions directes dans les réseaux des testeurs ; critère : taux mesuré en T4.2 et T4.6.

### 5.6 La politique d'entreprise (D54)

Une politique signée, déployée par l'informatique, fixe les clients autorisés, les fournisseurs de modèles autorisés, le relais interne obligatoire et l'interdiction des passerelles publiques. Le poste l'applique ; le relais la vérifie à nouveau. Existant (T4.10, `packages/node/src/policy.ts`).

### 5.7 L'app sur le poste

- Existant : app Mac de barre de menus (Tauri), Node embarqué, panneau de décision, équipe, outils et raccordement (`apps/desktop`, `packages/desktop-ui/src/panel/`). Le script de release sait notariser avec un profil du trousseau (`scripts/build-mac.ts`, `docs/MAC_RELEASE.md`).
- Existant : build signée et notarisée pour Apple Silicon, acceptée par Apple le 10 octobre 2026 ([preuve](../../openspec/changes/t3-4-private-mac-app/proof/verification.md)). Visé (T3.4) : installation sur un Mac propre et recette VoiceOver, humaines.
- Visé : Windows (T3.7), Linux (T3.8).

## 6. Simulation (D56)

Avant de confier drop à de vraies personnes, on le fait vivre dans une entreprise fictive.

- **Technique** : 50 nœuds en processus séparés, sur le Mac, avec un relais dédié : Existant (T4.1). Puis 500 nœuds virtuels regroupés : Visé (T4.7).
- **Usage** : 10 à 20 personnages joués par des modèles gratuits (passerelle LiteLLM du lab), qui se posent de vraies questions sur des données factices. Visé (T4.7).
- **Carte interactive** : vue équipe regroupable, vue parcours par demande façon n8n, lecture et pas à pas, injection de pannes et de sorties piégées. Visé (T4.7).
- **Boucle d'amélioration** : rapports, et ajustement versionné des seuls éléments sans risque (textes, routage, consignes des personnages). Jamais le code ni la sécurité.

La simulation ne valide pas le besoin : elle valide la robustesse et révèle où le parcours casse. Le besoin se mesure avec de vraies personnes (H1, H3).

## 7. Mesures de succès

| Phase | Mesure | Seuil |
|---|---|---|
| Simulation minimale (T4.1) | mémoire par nœud, latence de bout en bout, erreurs | fixés par la mesure de référence, puis tenus en régression |
| Essai P1 (T4.6) | blocages et minutes perdues | seuil D24 |
| Essai P1 (T4.6) | compréhension de la carte de décision | H3 |
| Essai P1 (T4.6) | demandes décidées dans la demi-heure | proposition à confirmer : au moins 70 % |
| Essai P1 (T4.6) | installation jusqu'à la première réponse | proposition à confirmer : moins de 10 minutes |
| Connexion (T4.2, T4.6) | connexions directes sans relais | H5 |

## 8. Argent (D57)

Rien de payant avant d'avoir des utilisateurs. Le socle reste libre sous Apache-2.0, et la sécurité n'est jamais une option payante (D38).

**Hypothèse H6.** Des contrats d'installation et de support, puis un pack entreprise (console de politiques, SSO, export d'audit, versions maintenues), financeront le projet. Critère : une première demande écrite d'un grand compte. Aucun tarif n'est fixé ; la recherche de positionnement du 9 octobre proposait des fourchettes sans preuve de consentement à payer.

Le nom du produit reste à choisir dans une session dédiée ; « drop » est le nom de code (D57).

## 9. Hors périmètre

- Conversation libre entre agents (niveau 5).
- Index central ou RAG d'entreprise.
- Relais de secours actif par défaut.
- Partage d'identifiants, remplacement des agents existants.
- Toute modification de code ou de sécurité par la boucle d'amélioration.
- Tarifs et lancement commercial avant P5.

## 10. Risques produit

| Risque | Effet | Réponse |
|---|---|---|
| Le besoin n'existe pas au niveau visé | produit sans usage | mesurer H1 en P1 avant toute autre extension |
| Les propriétaires approuvent par réflexe | la promesse devient formelle | carte qui montre ce qui part, compteur de décisions, tests H3 |
| La connexion échoue souvent sans relais | abandon à l'installation | explication claire, choix explicite d'un relais, mesure H5 |
| Le périmètre s'élargit trop vite (niveaux 2 à 4, contexte) | sécurité diluée | livrer dans l'ordre 3, 1, 2, 4, chaque niveau avec ses propres contrôles |
| Les grandes entreprises exigent des certifications | cycle long sans revenu | pack entreprise seulement sur demande écrite (H6) |

## 11. Références

- Décisions : D1, D24, D25, D34 à D38, D40, D46, D47 à D58 dans `docs/DECISIONS.md`.
- Recherches : `docs/research/2026-10-10-repositionnement.md`, `docs/research/2026-10-09-positionnement.md`.
- Documents liés : [TRD](TRD.md), [parcours](APP_FLOW.md), [UX/UI](UX_UI.md), [schéma backend](BACKEND_SCHEMA.md), [plan](IMPLEMENTATION_PLAN.md).
