# Installer un profil privé

T3.1 fournit le runtime privé. Le raccordement groupé est livré (T3.3, T4.5) et l'app Mac est signée et notarisée (T3.4, recette humaine restante). Restent la qualification d'un vrai modèle (T3.2) et la preuve d'ensemble avec Internet bloqué (T3.5).

## Frontière prise en charge

Le profil privé accepte une liste d’origines exactes (`schéma://IP:port`). Adresses acceptées : IPv4 loopback, 10/8, 172.16/12, 192.168/16, IPv6 `::1` et ULA. Pas de DNS, pas de `localhost`, de redirection, de proxy implicite ni de destination secondaire A2A différente de l’origine configurée. Les adresses de métadonnées cloud et les adresses publiques sont refusées. Utiliser les formes canoniques sans chemin ni port par défaut explicite dans la liste.

Le modèle et les serveurs MCP HTTP utilisent cette politique, y compris ceux référencés dans les fichiers des agents. Une requête A2A utilise la même origine pour la carte et les appels. Le relais est lui aussi validé. Une panne ne change pas de fournisseur. Le modèle doit être nommé explicitement ; l’URL Ollama locale proposée ne télécharge aucun poids.

Les serveurs MCP stdio, y compris ceux détectés chez un agent, sont refusés dans ce profil : leurs propres connexions ne sont pas contrôlées par le transport de drop. Les lecteurs de logs docker/journald sont également refusés ; une source fichier locale reste possible. Le connecteur **demandeur MCP stdio** reste pris en charge : il parle seulement à l’API locale. La limitation porte sur les processus source lancés par le propriétaire.

Le client doit aussi isoler les services internes (MCP, modèle, agent A2A) par son pare-feu ou son réseau de conteneurs. Un service autorisé peut lui-même accéder à d’autres systèmes : drop ne contrôle pas ses outils internes. Pour le test sur un laptop, `--network none` laisse fonctionner le loopback et interdit Internet. Pour plusieurs postes, utiliser un réseau interne/VPN administré, TLS en `wss` et HTTPS avec certificats valides pour les IP choisies. Aucun contournement de validation TLS.

## Démarrage local

Depuis un clone dont les dépendances sont installées, Node 22.18+ et pnpm (OpenSSL est également nécessaire pour le test TLS de la suite de développement) :

```bash
node packages/node/src/cli.ts init --name Alice --relay ws://127.0.0.1:7780/v1
```

Le Node affiche son identifiant public. Créer un fichier `relay.config.json` privé avec cet identifiant (remplacer la valeur ci-dessous) :

```json
{
  "port": 7780,
  "host": "127.0.0.1",
  "allowedNodeIds": ["IDENTIFIANT_PUBLIC_AFFICHE_PAR_INIT"],
  "revokedNodeIds": [],
  "admittedPath": "admitted.json"
}
```

```bash
chmod 600 relay.config.json
node packages/relay/src/cli.ts serve --config=relay.config.json
```

Dans un autre terminal :

```bash
node packages/node/src/cli.ts serve
```

Le daemon occupe ce terminal. Dans un troisième terminal, créer une invitation :

```bash
node packages/node/src/cli.ts invite
```

Le second propriétaire initialise son propre `DROP_HOME` sur le même relais, lance `serve`, puis exécute `pair <code>` dans un autre terminal. Sur le même laptop, choisir un autre `--port`. Un code valide permet l’admission sans ajouter manuellement chaque membre. Le fichier d’admission se trouve à côté de la config du relais lorsque le chemin est relatif. Il doit vivre sur un volume persistant.

Pour un endpoint interne supplémentaire, fournir `--network politique.json` à `init` :

```json
{
  "origins": ["ws://127.0.0.1:7780", "http://127.0.0.1:11434", "http://10.20.0.4:8080"]
}
```

Une publication MCP HTTP précise son serveur et son modèle déjà installé :

```json
{
  "label": "la documentation interne",
  "server": { "transport": "http", "url": "http://10.20.0.4:8080/mcp" },
  "tools": ["read_summary"],
  "provider": { "baseUrl": "http://127.0.0.1:11434/v1", "model": "NOM_DU_MODELE_INSTALLE", "apiKeyEnv": null }
}
```

Les outils restent choisis par le propriétaire ; aucune capacité n’est publiée par `init`. Pour un modèle authentifié, `apiKeyEnv` nomme une variable d’environnement, jamais la clé. Le mode privé initialise `payer: owner` et refuse le financement reçu dans ce mode. Si le propriétaire choisit `payer: requester`, une clé reçue doit correspondre à son URL et à son modèle, sans jamais les remplacer. La création automatique de clés OpenRouter et la passerelle grand public sont exclues du profil privé.

Pour un déploiement interne sans les sources TypeScript, `node scripts/bundle.ts` produit `dist/drop.mjs`, `dist/drop-mcp.mjs` et `dist/drop-relay.mjs`. Les commandes ci-dessus utilisent alors `node dist/drop.mjs` et `node dist/drop-relay.mjs`. Node reste requis ; un installateur public autonome est hors T3.1.

## Migrer une installation historique

Arrêter le daemon et l’app avant de modifier leur configuration. Ne pas exécuter la migration en parallèle d’un éditeur de configuration.

```bash
node packages/node/src/cli.ts migrate-private --relay ws://127.0.0.1:7780/v1 --network politique.json
node packages/node/src/cli.ts serve
```

`private-migration.json` conserve la configuration avant/après en mode 0600. Identité, jeton, pairs et publications restent identiques. Les publications qui désignent un service cloud sont conservées mais refusées par la politique privée ; les reconfigurer explicitement. Le défaut OpenRouter implicite est supprimé : renseigner le modèle et, si nécessaire, le fournisseur dans les publications existantes. Rien n’est téléchargé.

Pour revenir à la configuration précédente, arrêter le daemon puis lancer `rollback-private`. La restauration refuse une configuration modifiée depuis la migration. Une sauvegarde déjà présente n’est jamais écrasée. En cas d’arrêt brutal, consulter le PID dans `.private-migration.lock`, vérifier que ce processus et le daemon sont arrêtés, puis retirer uniquement ce verrou avant `rollback-private`. Si l’arrêt a précédé le remplacement, le retour arrière conserve simplement la configuration originale.

`--profile legacy` à l’initialisation reste une option explicite pour reproduire le prototype ; elle n’apporte aucune garantie du profil privé. Depuis T4.15, un `config.json` sans champ `profile` est lu comme privé : s’il n’en remplit pas les conditions, le Node refuse de démarrer (`E_DENIED invalid private profile`). Ajouter `"profile": "legacy"` pour garder un ancien fichier tel quel, ou lancer `drop migrate-private`, qui lit encore un fichier sans profil comme `legacy`. En profil privé, `payer` vaut `owner` s’il est omis et `requester` est refusé. `peers.json` et `team.json` sont en `0600` ; le daemon resserre au démarrage ceux qu’une version antérieure avait laissés lisibles. La restauration d’une config historique peut réactiver ses connexions externes.

## Exploiter le relais

```bash
node packages/relay/src/cli.ts revoke IDENTIFIANT_DU_MEMBRE [--with-invited] --config=relay.config.json
```

Avec `revokedPath` dans `relay.config.json`, le relais en marche applique la révocation en quelques secondes, sans redémarrage (T2.19) : le membre est coupé puis refusé, même avec une nouvelle invitation. Sans `revokedPath`, la révocation est écrite dans `relay.config.json` et ne s'applique qu'au redémarrage du relais. Elle prime sur l’allowlist, l’admission sauvegardée et les nouvelles invitations ; le membre ne peut plus parrainer. `--with-invited`, qui demande `revokedPath`, révoque aussi les membres qu'il avait fait admettre ; sans cette option, ils restent admis. Sauvegarder **ensemble**, relais arrêté, `relay.config.json`, `admitted.json` et le fichier de révocations avec droits privés. Restaurer les deux sur le volume interne, conserver les révocations, puis démarrer. Ne pas restaurer une sauvegarde antérieure à une révocation sans la réappliquer.

Sauvegarder les répertoires des Nodes séparément, daemon arrêté, sur un support privé chiffré géré par le client. Ne jamais joindre identité, jeton, publications ou sauvegarde de migration à un ticket de support. Les fichiers `received-drops/` sont des identifiants sans contenu qui empêchent une demande déjà reçue de retrouver un consentement après redémarrage : les conserver avec le Node. Une demande interrompue se recrée avec un nouvel identifiant ; elle n’est pas relancée automatiquement.

Depuis T3.1b, chaque **nouvelle** demande doit utiliser un `dropId` UUIDv7 horodaté ; les clients tiers qui émettent encore UUIDv4 doivent changer leur générateur avant mise à jour. Les clients Drop intégrés utilisent déjà UUIDv7. Une demande dont l’identifiant a plus de 30 minutes, ou plus de 5 minutes d’avance, est refusée avant accord. Le Node garde au plus 16 384 identifiants vivants, dont 1 024 au plus par pair émetteur : un pair qui a épuisé sa part reçoit `E_RATE` (journal `replay_peer_quota`) pendant que les autres restent admis.

Depuis T3.1e (format 3), ces identifiants vivent dans deux journaux, `received-drops-a.journal` et `received-drops-b.journal`, avec `received-drops-version` (`3`). Chaque enregistrement tient l’identifiant, une étiquette hachée du pair (jamais son nom) et l’horloge du stockage ; l’en-tête porte cette horloge, une génération et l’empreinte du corps. Une admission ajoute un enregistrement au journal valide et le synchronise avant de répondre : une seule synchronisation, sans renommage ni dossier à vider, ce qui la rend durable aussi sous Windows. Quand assez d’identifiants ont expiré, l’admission suivante réécrit l’autre journal avec les vivants puis vide l’ancien ; un seul journal est donc valide. La première admission après mise à jour vérifie l’ancien stockage (`received-drops/`, `-clock`, `-integrity`, `-version`) comme le faisait T3.1b, le migre sans perdre un identifiant vivant, écrit la version 3, puis retire les anciens fichiers ; un fichier `received-drops-upgrading` n’existe que pendant une migration interrompue, qui reprend ensuite seule. Sauvegarder ensemble les deux journaux et la version.

Après un crash, le Node reprend seul : un enregistrement final incomplet, jamais annoncé, est coupé, et une migration ou une compaction interrompue recommence. Le fichier `received-drops.lock` sérialise les admissions entre processus ; le Node reprend seul un verrou laissé par son propre processus ou par un processus disparu de ce poste et de ce démarrage, à travers une garde `received-drops.lock.takeover-*`. Tout autre verrou (dossier laissé par T3.1b, propriétaire illisible, autre poste ou autre démarrage, processus vivant) provoque `E_RATE` : arrêter alors **tous** les processus utilisant ce `DROP_HOME`, vérifier qu’aucun n’est encore actif, puis retirer uniquement ce verrou. Ne pas partager un même `DROP_HOME` entre plusieurs postes ou conteneurs : la preuve de mort d’un propriétaire suppose un disque local.

Si l’état anti-rejeu est perdu ou incohérent (journal absent ou endommagé, version absente ou inconnue, ancien stockage incomplet), le Node journalise la cause (`reason`) et ouvre une quarantaine, `received-drops-quarantine` : il refuse toute demande jusqu’à la plus haute horloge connue plus 35 minutes, même si l’heure du poste recule, puis repart d’un stockage vide dont l’horloge est au moins cette fin, de sorte que tout identifiant antérieur reste refusé comme périmé. Ne pas supprimer ce fichier pour abréger la quarantaine. Une erreur d’écriture passagère refuse seulement la demande en cours : son enregistrement est retiré avant le refus et l’admission suivante reprend sans intervention. Une version de drop antérieure à T3.1e refuse un stockage de format 3 (`corrupt version`) au lieu de le réinitialiser. Le quota d’enveloppes du relais suit l’identité du Node même après reconnexion au même processus.

Saut d’horloge en avant : si l’heure du poste a été réglée dans le futur et qu’une demande a été admise pendant ce temps, le journal garde cette heure et les demandes à l’heure juste reçoivent `E_EXPIRED` ; le journal du Node indique alors `replay_clock_ahead`. Corriger l’heure du poste et attendre : l’admission revient seule dès que l’heure réelle atteint cette horloge moins 30 minutes. Ne pas modifier les journaux pour accélérer la reprise : les reçus ne couvrent pas les demandes reçues mais encore sans issue. Restaurer une copie plus ancienne d’un journal, seule ou avec le reste, n’est pas détectable : un instantané antérieur aux dernières demandes ne peut pas être restauré avec la même identité sans risque de rejeu ; dans ce cas, créer une nouvelle identité et réappairer les pairs avant de rouvrir les admissions.

T3.1c borne aussi la mémoire du Node : au plus 1 024 demandes reçues en cours et 1 024 demandes émises dans l'historique local. Une issue reçue peut faire sortir la plus ancienne demande terminée du panneau ; les reçus signés sur disque ne sont pas supprimés. Une nouvelle demande reçoit `E_RATE` (HTTP 429 sur l'API locale) si toutes les places requises restent actives. Après l'issue d'une demande reçue, le Node libère l'entrée et la configuration en mémoire ; son marqueur anti-rejeu durable reste en place. Un refus terminé peut être répété au même demandeur grâce à un petit résumé temporaire, sans conserver l'entrée initiale. Une demande en cours n'est jamais évincée pour faire de la place.

La boîte d'approbation garde au plus 1 024 cartes valides, refuse les dates d'expiration trop lointaines et ne remplace jamais une carte encore visible par un message portant le même `dropId`. La file d'enveloppes hors ligne garde au plus 1 024 éléments en comptant l'envoi en cours, chacun limité par son expiration de protocole ; si elle sature, la plus ancienne enveloppe en attente est abandonnée et un diagnostic `outbox_capacity` est journalisé. Un seul vidage s'exécute à la fois ; chaque enveloppe y est tentée une fois et son ordre initial est conservé lorsqu'une reconnexion échoue pendant qu'un nouvel envoi arrive. Cette file est volatile : une panne longue ou un redémarrage ne garantit pas la livraison d'un résultat déjà produit. Une nouvelle demande initiale n'est pas mise dans cette file : si le relais est indisponible ou la refuse avec `E_RATE`/`E_QUEUE_FULL`, la place locale est retirée, la révocation de la clé plafonnée est déclenchée et `E_RATE` remonte à l'appelant. Si le fournisseur ne confirme pas la révocation, seul le hash reste en mémoire pour des tentatives différées, au plus jusqu'à l'expiration automatique de la clé (deux heures) ; cette reprise ne survit pas à un redémarrage. Les créations de clés simultanées réservent aussi une place dans la limite de 8 192 avant l'appel fournisseur. Le cache anti-rejeu des enveloppes refuse fermé après 65 536 identifiants non expirés ; le marqueur durable des demandes reçues reste séparé.

Diagnostic partageable : état connecté/déconnecté, code d’erreur, version et noms des tests passés. Aucun export automatique de configuration, de question, de réponse ou de jeton. La preuve ci-dessous ne garde que des métadonnées de paquets et des scénarios de fixture.

Retour arrière : la première demande reçue après T3.1b supprime définitivement les marqueurs UUIDv4 et ceux de plus de 30 minutes. Une version antérieure n’impose pas cette fenêtre de fraîcheur ; restaurer seulement des marqueurs ou des reçus ne suffit donc pas à empêcher le rejeu d’une demande sans reçu. Un instantané pris **avant** des demandes ultérieures perd aussi leurs marqueurs, même s’il est complet. Après toute admission T3.1b, arrêter les daemons, créer une nouvelle identité et réappairer les pairs avant de démarrer l'ancienne version. Restaurer un instantané avec la même identité n'est sûr que s'il précède toute première admission ou purge T3.1b **et** qu'aucune demande n'a été reçue depuis cet instantané. Après une admission T3.1e, une version antérieure refuse le stockage de format 3 (`corrupt version`) : la même procédure s’applique avant de la démarrer.

Les UUIDv7 en majuscules restent acceptés, mais sont normalisés en minuscules avant stockage. Les anciens marqueurs UUIDv7 en majuscules sont ramenés à cette forme lors de la prochaine demande ; un même identifiant ne peut ainsi pas recréer un accord sur un disque sensible à la casse.

## Rejouer la preuve sans Internet

Préparer les dépendances, l’image et les outils de capture avant l’usage isolé, ou les transférer par le canal interne du client. Depuis la racine :

```bash
node scripts/private-proof-build.ts
cp scripts/private-proof/Dockerfile scripts/private-proof/run.sh dist/private-proof/
docker build -t drop-private-proof:local dist/private-proof
mkdir -p dist/private-proof-evidence
docker run --rm --network none --mount type=bind,source="$PWD/dist/private-proof-evidence",target=/evidence drop-private-proof:local
```

Le conteneur crée des identités neuves, un relais, deux Nodes et des fixtures MCP/modèle sur loopback. Il joue accord/relecture/résultat, refus, panne du modèle, reprise du relais et des daemons, puis révocation/sauvegarde/restauration. Il observe toutes les interfaces du conteneur via `tcpdump -i any`, en métadonnées uniquement, et vérifie l’absence de route externe. Aucune télémétrie, activation, mise à jour ou téléchargement n’est nécessaire pendant ce parcours.

Les preuves ne qualifient ni un vrai modèle ni les connexions internes d’un agent tiers réel. Cette qualification et la recette complète sur Mac restent en T3.2/T3.5. Aucun service du lab n’est utilisé.
