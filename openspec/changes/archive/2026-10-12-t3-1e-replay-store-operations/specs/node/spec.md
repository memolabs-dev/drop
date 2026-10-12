## MODIFIED Requirements

### Requirement: Demandes reçues persistantes
Le Node MUST conserver au plus 16 384 identifiants reçus, sans contenu, pendant 30 minutes, dans un journal durable portant l'horloge du stockage, pour empêcher leur rejeu après redémarrage, crash ou recul d'horloge. Il MUST refuser avant accord les UUIDv7 vieux (>30 min) ou futurs (>5 min), les doublons et les admissions dont le stockage est saturé, verrouillé, illisible, incomplet ou non durable. Un stockage T3.1b MUST être vérifié puis migré sans perdre un identifiant vivant.

#### Scenario: AC: ancien consentement après redémarrage
<!-- openspec-guard:test="private restart > rejects a previously received drop after restart before any consent can be reused" -->
- **WHEN** une demande reçue avant arrêt est présentée au Node redémarré
- **THEN** elle est refusée sans nouvelle exécution ni remise en attente d'un ancien consentement

#### Scenario: AC: demande périmée ou future
<!-- openspec-guard:test="bounded received drops > rejects stale and future identifiers before writing a marker" -->
- **WHEN** une nouvelle demande porte un UUIDv7 plus vieux que 30 minutes ou avancé de plus de 5 minutes
- **THEN** le Node la refuse avant création d'une demande d'accord

#### Scenario: AC: marqueurs bornés après redémarrage
<!-- openspec-guard:test="replay store crash points > keeps the compacted journal as the only valid one" -->
- **WHEN** des identifiants périmés occupent le journal et le Node admet une demande récente
- **THEN** ils ne comptent plus dans les plafonds et la compaction les retire, sans réutiliser un ancien accord

#### Scenario: AC: retour d'horloge
<!-- openspec-guard:test="bounded received drops > prunes old markers and rejects them after restart and clock rollback" -->
- **WHEN** l'horloge locale recule après l'admission d'une demande plus récente
- **THEN** un identifiant déjà périmé reste refusé, y compris après redémarrage

#### Scenario: AC: stockage anti-rejeu saturé
<!-- openspec-guard:test="bounded received drops > refuses another claim at the marker cap" -->
- **WHEN** 16 384 identifiants non expirés occupent le stockage
- **THEN** le Node refuse une demande supplémentaire avec `E_RATE`, sans accord ni exécution

#### Scenario: AC: état anti-rejeu corrompu
<!-- openspec-guard:test="bounded received drops > fails closed when replay clock state is corrupt" -->
- **WHEN** l'en-tête du journal, qui porte l'horloge du stockage, est corrompu
- **THEN** le Node refuse les nouvelles demandes sans consentement ni exécution

#### Scenario: AC: admission concurrente
<!-- openspec-guard:test="bounded received drops > refuses a claim while another process owns the replay lock" -->
- **WHEN** un autre processus vivant possède le verrou d'admission du même `DROP_HOME`
- **THEN** le Node refuse la nouvelle demande sans rien écrire dans le stockage

#### Scenario: AC: même identifiant sous deux casses
<!-- openspec-guard:test="bounded received drops > treats lowercase and uppercase UUIDv7 as the same claim" -->
- **WHEN** le même UUIDv7 est reçu en minuscules puis en majuscules
- **THEN** le second envoi est refusé comme doublon, sans nouvel enregistrement ni consentement

#### Scenario: AC: migration d'un stockage T3.1b
<!-- openspec-guard:test="bounded received drops > migrates a format-2 store: live ids stay refused, uppercase ones merge, expired and pre-v7 ones go" -->
- **WHEN** un stockage de format 2 tient des marqueurs vivants, dont un en majuscules, un périmé et un UUIDv4
- **THEN** la première admission les vérifie, garde les vivants refusés comme doublons, abandonne les autres, écrit la version 3 puis retire les anciens fichiers

#### Scenario: AC: anciens marqueurs nil et max
<!-- openspec-guard:test="bounded received drops > deletes legacy nil and max UUID markers instead of blocking admission" -->
- **WHEN** le stockage à migrer contient un marqueur nil ou max accepté avant T3.1b
- **THEN** le Node l'abandonne et admet la nouvelle demande récente

#### Scenario: AC: fichiers étrangers dans le stockage
<!-- openspec-guard:test="bounded received drops > ignores operating system and foreign entries in the marker directory" -->
- **WHEN** `received-drops/` à migrer contient un fichier ou dossier dont le nom n'a pas la forme d'un UUID, comme `.DS_Store`
- **THEN** le Node l'ignore sans le compter et migre les marqueurs

#### Scenario: AC: entrée de forme UUID qui n'est pas un fichier
<!-- openspec-guard:test="bounded received drops > still fails closed on a marker-shaped entry that is not a file" -->
- **WHEN** `received-drops/` à migrer contient un dossier dont le nom a la forme d'un UUID
- **THEN** le Node refuse l'admission au lieu de migrer

#### Scenario: AC: stockage T3.1b incomplet
<!-- openspec-guard:test="bounded received drops > quarantines a format-2 store that lost its clock, its markers, one live marker or its version" -->
- **WHEN** un stockage de format 2 a perdu son horloge, son dossier de marqueurs, un marqueur vivant ou sa version
- **THEN** le Node refuse avec la cause, sans migrer, et n'admet de nouveau qu'à la fin de la quarantaine, où l'identifiant perdu est refusé comme périmé

#### Scenario: AC: horloge anti-rejeu perdue
<!-- openspec-guard:test="bounded received drops > quarantines a format-2 store that lost its clock, its markers, one live marker or its version" -->
- **WHEN** le fichier d'horloge d'un stockage T3.1b manque
- **THEN** le Node refuse toute admission sans recréer une horloge initiale, jusqu'à la fin de la quarantaine

#### Scenario: AC: marqueurs anti-rejeu perdus
<!-- openspec-guard:test="replay store journal (T3.1e) > quarantines a home whose journal or version disappeared instead of starting afresh" -->
- **WHEN** le journal disparaît après une admission
- **THEN** le Node ne repart pas d'un stockage vide : il refuse pendant la quarantaine puis refuse l'ancien identifiant comme périmé

#### Scenario: AC: marqueur anti-rejeu isolé perdu
<!-- openspec-guard:test="replay store journal (T3.1e) > quarantines a journal damaged before its last record, then admits again past every id it held" -->
- **WHEN** un enregistrement du journal est endommagé alors qu'un enregistrement valide le suit
- **THEN** le Node refuse avec `corrupt journal`, reste en quarantaine même si l'horloge recule, puis admet de nouveau à sa fin et refuse comme périmés les identifiants de l'état perdu

#### Scenario: AC: version anti-rejeu perdue
<!-- openspec-guard:test="replay store journal (T3.1e) > quarantines a home whose journal or version disappeared instead of starting afresh" -->
- **WHEN** le fichier de version manque alors qu'un journal valide montre un stockage déjà utilisé
- **THEN** le Node refuse l'admission sans réinitialiser l'état anti-rejeu avant la fin de la quarantaine

#### Scenario: AC: version inconnue
<!-- openspec-guard:test="replay store journal (T3.1e) > refuses a version it does not know, such as one written by a newer node" -->
- **WHEN** `received-drops-version` porte une version que ce Node ne connaît pas
- **THEN** le Node refuse l'admission

#### Scenario: AC: verrou abandonné par ce processus
<!-- openspec-guard:test="bounded received drops > reclaims only its own replay lock and refuses an old foreign lock" -->
- **WHEN** le verrou d'admission porte le nonce du processus courant, sans admission synchrone en cours
- **THEN** le Node reprend ce verrou et traite la demande

#### Scenario: AC: verrou d'un autre processus
<!-- openspec-guard:test="bounded received drops > reclaims only its own replay lock and refuses an old foreign lock" -->
- **WHEN** le verrou porte un autre propriétaire dont la mort n'est pas prouvée (format T3.1b, autre poste, autre démarrage), même s'il semble ancien
- **THEN** le Node refuse la demande sans toucher au verrou

#### Scenario: AC: verrou d'un processus vivant
<!-- openspec-guard:test="bounded received drops > keeps a replay lock owned by another live process" -->
- **WHEN** le verrou appartient à un processus encore vivant de ce poste et de ce démarrage
- **THEN** le Node refuse la demande sans toucher au verrou

#### Scenario: AC: verrou sans propriétaire
<!-- openspec-guard:test="bounded received drops > requires manual removal of an ownerless replay lock before admission resumes" -->
- **WHEN** un verrou sans propriétaire lisible subsiste (dossier laissé par T3.1b), même ancien
- **THEN** le Node refuse toute admission jusqu'au retrait manuel après arrêt de tous les processus qui partagent ce `DROP_HOME`

#### Scenario: AC: ancienne sentinelle de reprise
<!-- openspec-guard:test="bounded received drops > never takes over a foreign replay lock even when its takeover sentinel is old" -->
- **WHEN** un verrou T3.1b et une sentinelle de reprise anciens subsistent
- **THEN** le Node refuse la demande et laisse le verrou en place

#### Scenario: AC: doublon d'une demande terminée
<!-- openspec-guard:test="replay admission through the engine > answers a duplicate of a finished request with its recorded outcome" -->
- **WHEN** le même demandeur renvoie une demande déjà refusée ou échouée
- **THEN** le Node renvoie la même erreur, sans nouvel accord

#### Scenario: AC: identifiant actif réutilisé par un autre pair
<!-- openspec-guard:test="replay admission through the engine > refuses another peer reusing an active drop id without revealing its state" -->
- **WHEN** un autre pair envoie l'identifiant d'une demande active
- **THEN** il reçoit `E_DENIED` sans l'état de la demande

#### Scenario: AC: résultat réel après un refus de doublon
<!-- openspec-guard:test="end to end, in memory: relay and three nodes > a real result still lands after an overtaking refusal or a premature delivered status, and funding is released once" -->
- **WHEN** un refus de doublon ou un `drop_status` annonçant une livraison précède le vrai résultat
- **THEN** le demandeur enregistre le vrai résultat et libère le financement une seule fois

#### Scenario: AC: horloge anti-rejeu en avance
<!-- openspec-guard:test="replay admission through the engine > refuses a request after clock rollback with E_EXPIRED and logs that the replay clock is ahead" -->
- **WHEN** l'horloge persistante est en avance sur l'horloge du Node
- **THEN** la demande reçoit `E_EXPIRED` sans accord et le journal indique `replay_clock_ahead`

#### Scenario: AC: doublon d'une demande active
<!-- openspec-guard:test="replay admission through the engine > answers a duplicate of an active request with its current state" -->
- **WHEN** une demande encore en attente ou en cours est reçue une seconde fois du même demandeur
- **THEN** le Node répond par un `drop_status` portant l'état courant, sans nouvel accord

#### Scenario: AC: issue finale conservée chez le demandeur
<!-- openspec-guard:test="end to end, in memory: relay and three nodes > a late executor update cannot rewrite a finished outbound drop" -->
- **WHEN** un `drop_error` ou un `drop_status` arrive après l'issue finale d'une demande
- **THEN** le demandeur conserve l'issue déjà reçue

#### Scenario: AC: décision de relecture reçue deux fois
<!-- openspec-guard:test="end to end, in memory: relay and three nodes > records one result and receipt when the approver repeats a review decision concurrently" -->
- **WHEN** deux décisions de relecture pour la même demande arrivent pendant l'envoi du résultat
- **THEN** l'exécuteur n'émet qu'un résultat et un reçu

#### Scenario: AC: délai de relecture pendant l'envoi
<!-- openspec-guard:test="end to end, in memory: relay and three nodes > does not expire a review while its accepted result is being sent" -->
- **WHEN** la relecture acceptée est en cours d'envoi et son délai expire
- **THEN** l'exécuteur ne produit pas de reçu d'expiration contradictoire

### Requirement: Nettoyage des écritures anti-rejeu échouées
Le Node MUST supprimer le fichier temporaire d'une écriture durable échouée, afin qu'une panne répétée n'accumule pas de fichiers hors de la borne anti-rejeu.

#### Scenario: AC: échec répété de l'écriture durable
<!-- openspec-guard:test="replay clock write failures > does not accumulate temporary files when durable writes repeatedly fail" -->
- **WHEN** chaque synchronisation échoue pendant plusieurs premières admissions d'un `DROP_HOME` neuf
- **THEN** le Node refuse chaque demande sans laisser de fichier temporaire

### Requirement: Panne passagère sans blocage de l'admission
Une erreur passagère d'écriture ou de synchronisation MUST refuser seulement la demande en cours, sans laisser le stockage anti-rejeu refuser les suivantes : un enregistrement dont la synchronisation a échoué est retiré du journal avant le refus, une compaction échouée est vidée pour ne jamais devenir le journal valide, et une migration ou une reprise interrompue recommence grâce à un marqueur écrit en premier et retiré en dernier.

#### Scenario: AC: panne passagère après création du marqueur
<!-- openspec-guard:test="replay clock write failures > cuts off a record whose flush failed, so the refused id is admitted once and admission keeps working" -->
- **WHEN** la synchronisation du journal échoue après l'écriture de l'enregistrement d'une nouvelle demande
- **THEN** cette demande est refusée, son enregistrement est retiré, l'admission suivante réussit et le même identifiant est admis au plus une fois

#### Scenario: AC: empreinte déjà en place
<!-- openspec-guard:test="replay clock write failures > keeps admitting after a transient sync failure at any step of a claim that compacts the journal" -->
- **WHEN** seule la synchronisation qui vide l'ancien journal échoue, après celle du journal compacté
- **THEN** le journal compacté reste le seul valide au redémarrage, le même identifiant est refusé comme doublon et une autre demande est admise

#### Scenario: AC: panne passagère pendant la purge
<!-- openspec-guard:test="replay clock write failures > keeps admitting after a transient sync failure at any step of a claim that compacts the journal" -->
- **WHEN** une synchronisation échoue à n'importe quelle étape d'une admission qui compacte le journal
- **THEN** cette demande est refusée, puis le même identifiant est admis au plus une fois et une autre demande est admise, sans réparation manuelle

#### Scenario: AC: panne passagère pendant la première admission
<!-- openspec-guard:test="replay clock write failures > keeps admitting after a transient sync failure at any step of the first claim on a fresh home" -->
- **WHEN** une synchronisation échoue pendant la première admission d'un `DROP_HOME` neuf
- **THEN** la création reprend à l'admission suivante au lieu de refuser toute demande

#### Scenario: AC: panne passagère pendant la migration
<!-- openspec-guard:test="replay clock write failures > keeps admitting after a transient sync failure at any step of the upgrade of a format-2 store" -->
- **WHEN** une synchronisation échoue pendant la migration d'un stockage de format 2
- **THEN** la migration reprend à l'admission suivante et l'identifiant migré reste refusé

#### Scenario: AC: panne passagère pendant la reprise après quarantaine
<!-- openspec-guard:test="replay clock write failures > keeps admitting after a transient sync failure at any step of the restart after a quarantine" -->
- **WHEN** une synchronisation échoue pendant la première admission qui suit une quarantaine
- **THEN** la reprise recommence à l'admission suivante

#### Scenario: AC: empreinte antérieure aux planchers
<!-- openspec-guard:test="bounded received drops > verifies a digest written before floors and refuses to migrate a store that lost a marker" -->
- **WHEN** l'empreinte durable a été écrite par une version qui ne portait pas de plancher
- **THEN** elle est vérifiée sur tout le jeu avant la migration, et la perte d'un marqueur récent est refusée

## ADDED Requirements

### Requirement: Part de chaque pair dans le stockage anti-rejeu
Le Node MUST refuser avec `E_RATE`, avant tout accord, la demande d'un pair qui tient déjà 1 024 identifiants vivants, tandis que les autres pairs restent admis. Le compte MUST survivre au redémarrage et ne nomme pas le pair (étiquette hachée). Les identifiants migrés sans émetteur ne comptent que dans le plafond global. Le journal du Node porte `replay_peer_quota`, ou `replay_capacity` pour la saturation globale.

#### Scenario: AC: part d'un pair épuisée
<!-- openspec-guard:test="replay store per-peer share (T3.1e) > refuses a peer holding its share of live ids while other peers are still admitted" -->
- **WHEN** un pair tient 1 024 identifiants vivants
- **THEN** sa demande suivante est refusée, y compris après redémarrage, un autre pair est admis, et le premier l'est de nouveau quand ses identifiants expirent

#### Scenario: AC: identifiants migrés sans émetteur
<!-- openspec-guard:test="replay store per-peer share (T3.1e) > counts ids migrated without a sender only against the global cap" -->
- **WHEN** plus de 1 024 identifiants migrés sans émetteur sont vivants
- **THEN** un pair reste admis tant que le plafond global n'est pas atteint

#### Scenario: AC: refus par pair à travers le moteur
<!-- openspec-guard:test="replay admission through the engine > refuses a peer holding its replay share with E_RATE before consent, while another peer is admitted" -->
- **WHEN** le pair qui tient sa part envoie une demande, puis un autre pair en envoie une
- **THEN** le premier reçoit `E_RATE` sans carte d'accord et le journal porte `replay_peer_quota`, le second obtient une carte d'accord

### Requirement: Coût et durabilité d'une admission
Une admission MUST coûter une seule synchronisation, celle du journal où son enregistrement est ajouté, sans renommage, lecture ni synchronisation de dossier, quel que soit le nombre d'identifiants vivants. Elle ne retourne qu'après cette synchronisation, de sorte qu'une coupure de courant ne puisse défaire une admission annoncée, y compris sous Windows.

#### Scenario: AC: une synchronisation par admission
<!-- openspec-guard:test="replay clock write failures > admits with a single flush of the journal, without renaming, listing or flushing a folder" -->
- **WHEN** le Node admet des demandes alors que 16 000 identifiants sont vivants
- **THEN** chaque admission fait exactement une synchronisation de fichier, aucune de dossier, aucun renommage et aucune lecture de dossier

#### Scenario: AC: dossier vidé seulement hors de Windows
<!-- openspec-guard:test="directory flush of the private stores (T3.1e) > flushes a directory on macOS and Linux, and skips only that call on Windows, which cannot flush one" -->
- **WHEN** la création des journaux doit être rendue durable
- **THEN** le dossier est vidé sous macOS et Linux, et seul cet appel est sauté sous Windows

### Requirement: Index anti-rejeu partagé entre processus
Sous le verrou, les en-têtes et la taille des deux journaux MUST prouver que l'index en mémoire est à jour, sinon il est relu. La compaction réécrit l'autre journal avec la génération suivante puis vide l'ancien, de sorte qu'un seul journal soit valide.

#### Scenario: AC: deux processus sur le même stockage
<!-- openspec-guard:test="replay store journal (T3.1e) > sees the admissions and compactions of another process sharing the home" -->
- **WHEN** deux processus admettent tour à tour sur le même `DROP_HOME` et que l'un compacte le journal
- **THEN** chacun refuse les identifiants admis par l'autre et l'autre ajoute ensuite au nouveau journal, jamais à l'ancien

### Requirement: Reprise après crash
Un crash à n'importe quel point d'une admission MUST laisser un stockage que le redémarrage reprend sans intervention : tout identifiant admis avant reste refusé, l'identifiant interrompu est admis au plus une fois, et un enregistrement final incomplet, jamais annoncé, est coupé.

#### Scenario: AC: crash pendant une admission ordinaire
<!-- openspec-guard:test="replay store crash points > recovers from a crash at any point of an ordinary claim" -->
- **WHEN** le processus s'arrête à n'importe quel appel du système de fichiers d'une admission, une écriture pouvant rester à moitié faite
- **THEN** au redémarrage les identifiants admis avant sont refusés, l'identifiant interrompu est admis au plus une fois et une autre demande est admise

#### Scenario: AC: crash pendant une compaction
<!-- openspec-guard:test="replay store crash points > recovers from a crash at any point of a claim that compacts the journal" -->
- **WHEN** le processus s'arrête à n'importe quel point d'une admission qui compacte le journal
- **THEN** le même résultat tient, sans quarantaine

#### Scenario: AC: crash pendant la première admission
<!-- openspec-guard:test="replay store crash points > recovers from a crash at any point of the first claim on a fresh home" -->
- **WHEN** le processus s'arrête à n'importe quel point de la première admission d'un `DROP_HOME` neuf
- **THEN** la création reprend au redémarrage

#### Scenario: AC: crash pendant la migration
<!-- openspec-guard:test="replay store crash points > recovers from a crash at any point of the upgrade of a format-2 store" -->
- **WHEN** le processus s'arrête à n'importe quel point de la migration d'un stockage de format 2
- **THEN** la migration reprend et l'identifiant migré reste refusé

#### Scenario: AC: crash pendant la reprise après quarantaine
<!-- openspec-guard:test="replay store crash points > recovers from a crash at any point of the restart after a quarantine" -->
- **WHEN** le processus s'arrête à n'importe quel point de la première admission qui suit une quarantaine
- **THEN** la reprise recommence et l'identifiant de l'état perdu reste refusé comme périmé

#### Scenario: AC: enregistrement final incomplet
<!-- openspec-guard:test="replay store journal (T3.1e) > cuts a torn last record, which no admission returned for, and keeps admitting" -->
- **WHEN** le journal se termine par un enregistrement partiel ou nul
- **THEN** il est coupé, les identifiants admis restent refusés et l'admission continue

### Requirement: Reprise d'un verrou abandonné
Le Node MUST reprendre un verrou dont le propriétaire est prouvé mort (même poste, même démarrage et, sous Linux, même espace de PID, processus disparu), à travers une garde nommée d'après ce propriétaire. Il MUST laisser en place tout autre verrou.

#### Scenario: AC: verrou d'un processus mort
<!-- openspec-guard:test="bounded received drops > takes over a lock whose owner is provably dead, through a guard a live taker keeps" -->
- **WHEN** le propriétaire du verrou est un processus disparu de ce poste et de ce démarrage
- **THEN** le Node le reprend, sauf tant qu'un processus vivant tient la garde de cette reprise ; une garde laissée par un preneur mort est reprise de la même façon

### Requirement: Quarantaine après perte d'état
Une perte ou une incohérence de l'état anti-rejeu MUST ouvrir une quarantaine durable : toute admission est refusée jusqu'à la plus haute horloge connue plus 35 minutes, même si l'horloge recule. Le stockage repart ensuite avec une horloge au moins égale à cette fin, de sorte que tout identifiant antérieur reste refusé comme périmé.

#### Scenario: AC: fin de quarantaine
<!-- openspec-guard:test="replay store journal (T3.1e) > quarantines a journal damaged before its last record, then admits again past every id it held" -->
- **WHEN** la quarantaine ouverte par un journal endommagé arrive à son terme
- **THEN** une nouvelle demande est admise et les identifiants de l'état perdu sont refusés comme périmés, l'horloge du journal valant la fin de la quarantaine
