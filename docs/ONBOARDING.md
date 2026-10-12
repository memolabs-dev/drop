# Raccorder ses agents en deux confirmations

**Existant : T3.3 est livrée, vérifiée sur fixtures, en attente de recette manuelle.** La change est archivée ([vérification](../openspec/changes/archive/2026-10-09-t3-3-local-agent-onboarding/proof/verification.md)) ; la recette humaine sur un Mac de test reste à faire. Le panneau local (`packages/desktop-ui/src/panel/`) permet d'analyser les treize clients de D55 (T4.5, D66, `packages/capabilities/src/clients.ts`), de les sélectionner, puis de confirmer l'ajout. Depuis T4.22 (D84, D85), les treize se raccordent automatiquement sur macOS, Windows et Linux ; la configuration à copier ne reste qu'en secours, avec sa raison, quand drop ne peut pas écrire. L'app Mac est signée et notarisée ; sa recette sur un Mac propre reste à faire (T3.4). L'expérience dans la barre de menus n'est donc pas encore validée sur une installation neuve.

## Ce que couvrent les deux confirmations

Prérequis : app installée, Node local prêt, environnement sélectionné. Une autorisation macOS, l'acceptation d'une invitation d'équipe ou un téléchargement de modèle restent des étapes distinctes. Raccorder un agent lui ajoute le connecteur MCP drop ; cela ne publie aucun de ses outils.

1. **Analyser ce Mac.** Le bouton lance une lecture des seuls emplacements connus. L'aperçu indique, par agent, si l'ajout est prêt, déjà fait, en conflit ou en erreur. Il ne montre ni valeurs de secrets ni arguments des serveurs existants ; aucun outil découvert n'est exécuté et l'analyse n'envoie rien sur le réseau.
2. **Connecter les agents sélectionnés.** La confirmation ajoute uniquement le connecteur drop aux agents cochés. Chaque agent retourne son résultat ; un fichier modifié depuis l'aperçu est refusé. Il faut relancer l'agent pour charger sa nouvelle configuration.

Le panneau distingue « configuration raccordée », « connecteur utilisable à vérifier après relance » et « équipe joignable ». Le raccordement peut réussir quand l'équipe est hors ligne. Aucun succès de bout en bout n'est annoncé si une relance ou une confirmation dans l'agent reste nécessaire.

## Les quatre premiers adaptateurs (T3.3)

| Agent          | Source connue sur Mac                                             | Raccordement                                                    |
| -------------- | ----------------------------------------------------------------- | --------------------------------------------------------------- |
| Claude Code    | `~/.claude.json`, utilisateur et projets                          | CLI officielle, portée utilisateur, résultat relu               |
| Codex          | `$CODEX_HOME/config.toml`, sinon `~/.codex/config.toml`           | CLI officielle, résultat relu                                   |
| Cursor         | `~/.cursor/mcp.json`                                              | Fichier temporaire renommé, sauvegarde privée de trois versions |
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` | Fichier temporaire renommé, sauvegarde privée de trois versions |

Sources : `packages/capabilities/src/agents.ts` pour les emplacements, `packages/node/src/onboarding.ts` et `packages/node/src/install.ts` pour le raccordement, D45 pour les choix.

## Treize clients sur trois systèmes (T4.5, T4.22, D66, D84, D85)

Tous automatiques. Claude Code et Codex passent par leur commande officielle ; les onze autres par leur fichier documenté, édité en place : seule l'entrée drop change, commentaires, ordre, indentation, fins de ligne et BOM restent, et le retrait rend le fichier d'origine.

| Client | macOS | Windows | Linux | Raccordement |
| --- | --- | --- | --- | --- |
| Claude Code | `~/.claude.json` | `%USERPROFILE%\.claude.json` | `~/.claude.json` | `claude mcp add --scope user`, résultat relu |
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` | `%APPDATA%\Claude\claude_desktop_config.json` (copie privée de la version Store d'abord) | non documenté : secours | Fichier JSON |
| Cursor | `~/.cursor/mcp.json` | `%USERPROFILE%\.cursor\mcp.json` | `~/.cursor/mcp.json` | Fichier JSON |
| Codex | `~/.codex/config.toml` (`$CODEX_HOME`) | `%USERPROFILE%\.codex\config.toml` | `~/.codex/config.toml` | `codex mcp add`, résultat relu |
| OpenCode | `~/.config/opencode/opencode.json(c)` | `%USERPROFILE%\.config\opencode\opencode.json(c)` | `~/.config/opencode/opencode.json(c)` | Fichier JSONC, `mcp` ou `mcp.servers` selon le fichier |
| Gemini CLI | `~/.gemini/settings.json` | `%USERPROFILE%\.gemini\settings.json` | `~/.gemini/settings.json` | Fichier JSONC |
| Devin Desktop (Windsurf) | `~/.config/devin/mcp_config.json` | `%APPDATA%\devin\mcp_config.json` | `~/.config/devin/mcp_config.json` | Fichier JSONC ; anciens fichiers lus, jamais écrits |
| Zed | `~/.config/zed/settings.json` | `%APPDATA%\Zed\settings.json` | `~/.config/zed/settings.json` | Fichier JSONC, `context_servers` |
| goose | `~/.config/goose/config.yaml` | `%APPDATA%\Block\goose\config\config.yaml` | `~/.config/goose/config.yaml` | Fichier YAML, `extensions` |
| VS Code (Copilot) | `~/Library/Application Support/Code/User/mcp.json` | `%APPDATA%\Code\User\mcp.json` | `~/.config/Code/User/mcp.json` | Fichier JSONC, `servers` ; retrait automatique |
| Cline | `~/.cline/data/settings/cline_mcp_settings.json` | `%USERPROFILE%\.cline\data\settings\cline_mcp_settings.json` | `~/.cline/data/settings/cline_mcp_settings.json` | Fichier JSON |
| Roo Code (archivé) | `…/Code/User/globalStorage/rooveterinaryinc.roo-cline/settings/mcp_settings.json` | idem sous `%APPDATA%\Code\User` | idem sous `~/.config/Code/User` | Fichier JSON |
| JetBrains AI | Junie : `~/.junie/mcp/mcp.json` | `%USERPROFILE%\.junie\mcp\mcp.json` | `~/.junie/mcp/mcp.json` | Fichier JSON ; le chat AI Assistant importe depuis Claude dans l'IDE |

Les variables documentées déplacent ces fichiers pour le vrai dossier personnel : `XDG_CONFIG_HOME`, `APPDATA`, `CODEX_HOME`, `GEMINI_CLI_HOME`, `OPENCODE_CONFIG`, `GOOSE_PATH_ROOT`, `CLINE_MCP_SETTINGS_PATH`, `CLINE_DIR`, `CLINE_DATA_DIR`. Projets : `.mcp.json`, `.cursor/mcp.json`, `.codex/config.toml`, `opencode.json(c)`, `.opencode/`, `.gemini/settings.json`, `.devin/mcp_config.json`, `.zed/settings.json`, `.vscode/mcp.json`, `.roo/mcp.json`, `.junie/mcp/mcp.json`, lus seulement.

Un client est dit installé par son application, son binaire ou son extension, jamais par un dossier de configuration seul ; les quatre clients de T3.3 gardent aussi leur fichier comme signe. Sous Windows, le `PATH` se lit avec `;` et les extensions de `PATHEXT` ; les applications sont cherchées dans `%LOCALAPPDATA%\Programs` et `Program Files`, sous Linux dans les dossiers de fichiers `.desktop`. Sous Windows, une commande officielle installée par npm (`.cmd`) passe par `cmd.exe` seulement si ses arguments sont sûrs entre guillemets. Les configurations par projet sont lues dans les projets que Claude Code et Codex connaissent déjà et dans les dossiers ajoutés depuis le panneau ; aucun projet n'est raccordé automatiquement. Sources par client et par système : [note du 11 octobre](research/2026-10-11-clients-par-systeme.md).

**Secours expliqué.** La configuration à copier, ou la commande à lancer, n'apparaît que si drop ne peut pas écrire : fichier illisible ou invalide (`E_CONFIG_INVALID_OR_UNREADABLE`), verrouillé (`E_CONFIG_LOCKED`), emplacement non documenté (`E_CONFIG_UNDOCUMENTED`, Claude Desktop sous Linux), commande officielle absente (`E_CLI_MISSING`) ou arguments non sûrs pour `cmd.exe` (`E_CLI_SHIM_UNSAFE`). Elle dit pourquoi, quoi coller et où.


Pas de scan du disque, des conversations, du trousseau ou des ports. L'aperçu masque les valeurs d'environnement, en-têtes et arguments sensibles. Une config illisible n'est pas assimilée à un agent absent. Si aucun client n'est présent, le panneau affiche « Aucun des treize clients détecté » et une entrée MCP stdio à copier.

## Échecs et restauration

| Situation                                     | Résultat attendu                                                                                           |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Aucun agent compatible                        | État vide et voie manuelle, aucune écriture                                                                |
| Fichier malformé, droits refusés, CLI absente | Erreur par agent, aucun écrasement ni réparation automatique                                               |
| Entrée drop identique                         | Succès sans changement ni doublon                                                                          |
| Entrée drop différente                        | Conflit et choix explicite, aucun remplacement silencieux                                                  |
| Config modifiée depuis l'aperçu               | Arrêt pour cet agent et nouvelle analyse                                                                   |
| Échec partiel                                 | Succès identifiés, reprise ciblée des échecs                                                               |
| Interruption pendant l'écriture               | Fichier JSON temporaire puis renommage ; fichier d'origine préservé si la vérification de fraîcheur échoue |
| Déconnexion                                   | Retirer seulement notre entrée, préserver les changements ultérieurs                                       |

Les sauvegardes locales sont privées, versionnées et limitées à trois par fichier. La déconnexion retire seulement l'entrée drop reconnue, sans restaurer aveuglément un fichier entier. Les CLI officielles ne fournissent pas de transaction : le Node vérifie leur résultat et signale `E_CLI_UNVERIFIED` si l'entrée attendue n'apparaît pas. Après un échec CLI partiel, la récupération se fait manuellement à partir de la sauvegarde ; elle n'est pas annoncée comme automatique.

## Après le raccordement

### Rejoindre une équipe par un seul lien (T4.23, D95)

Côté inviteur, « Inviter quelqu'un » (Mon espace, Équipe), « Inviter quelqu’un dans l’équipe » (panneau de la barre de menus, onglet Équipe) ou `drop invite --link` donne un lien de la forme `https://drop.memolabs.dev/join#<invitation>`. Il vaut 24 h, sert une seule fois, pour une seule personne. L'invitation est signée par le Node de l'inviteur et porte son nom, celui de l'équipe, l'adresse du relais (`wss://drop.memolabs.dev/v1` pour l'essai) et un ticket d'admission à ce relais. Elle est dans la partie du lien après `#`, qu'un navigateur n'envoie jamais au site. Le Node de l'inviteur garde ses invitations vivantes : un lien envoyé reste valable si son Mac redémarre.

Côté invité :

1. Ouvrir le lien. La page affiche « Guillaume t'invite dans l'équipe Atelier », reconnaît le système et propose le téléchargement (page des versions de drop sur GitHub). Elle n'envoie rien.
2. Installer drop et l'ouvrir une fois.
3. Cliquer sur « J'ai installé drop : rejoindre l'équipe ». drop s'ouvre sur la carte de confirmation : qui invite, quelle équipe, « Rejoindre » ou « Refuser ». Rien n'est envoyé avant « Rejoindre ».
4. « Rejoindre » : un poste qui n'a encore rejoint personne et qui est encore sur le relais de bouclage par défaut (`ws://127.0.0.1:7780/v1`) passe au relais de l'invitation, y est admis par le ticket, puis apparaît dans l'équipe. Un poste déjà relié, ou réglé à la main sur un autre relais, garde son relais (T4.33). Le relais adopté n'entre pas dans les destinations privées (`network.origins`) : seul le Node lui parle, jamais le modèle ni un serveur MCP ; `config.json` porte alors `relayAdopted: true`.
5. Connecter ses agents. Dans le panneau, une carte « Prochaine étape » suit « Rejoindre » : « Connecter mes agents » ouvre « Mes outils » et analyse l'ordinateur sans rien modifier, puis « Connecter les agents sélectionnés » raccorde ceux qui restent cochés (T4.31). Quand le poste vient de passer au relais de l'invitation, la carte le nomme. Dans Mon espace : Agents, « Analyser cet ordinateur », puis « Connecter », comme décrit plus haut.

Si le bouton ne fait rien, la page donne le code à copier : dans drop, Mon espace, Équipe, « J'ai reçu une invitation », coller le code ou le lien entier. En ligne de commande : `drop join <code-ou-lien>`.

Refus possibles, chacun avec son code : invitation illisible (`E_INVITE`), expirée (`E_INVITE_EXPIRED`), modifiée depuis son envoi (`E_INVITE_SIG`), déjà utilisée (`E_INVITE_USED`), relais non autorisé sur ce poste (`E_INVITE_RELAY` : `ws:` seulement vers une adresse privée, `wss:` vers une adresse privée ou un nom DNS, puis la liste de la politique d'organisation), configuration de drop verrouillée par une autre opération (`E_LOCKED`) ou modifiée pendant « Rejoindre » (`E_CONFLICT`) ; dans ces deux derniers cas l'invitation reste valable et il suffit de réessayer.

Un lien `drop://pair` (T4.14) ouvre la même carte (`packages/desktop-ui/src/panel/`) ; plus aucun écran de drop n'en donne à envoyer (T4.31).

Sous Windows et Linux, le lien `drop://join` du bouton de la page arrive à l'app déjà ouverte (instance unique, D90). Une AppImage, que rien n'installe, enregistre `drop://` pour l'utilisateur à chaque lancement ; un échec est écrit dans `~/.drop/app.log` (`E_DEEP_LINK`) et le code à copier reste le secours (T4.31).

**Partager un outil, ce qui existe.** Dans « Mes outils », chaque serveur MCP partageable d'un agent installé porte un interrupteur « Partager … ». Un clic suffit (`packages/desktop-ui/src/panel/`, `packages/node/src/share.ts`) :

- la capacité publiée est `mcp.answer` sur ce serveur, nommée « mon » suivi du genre ou du nom du serveur ;
- les outils retenus sont ceux que le serveur marque lui-même en lecture seule (`readOnlyHint`) ; si aucun ne l'est, le partage est refusé et le message d'erreur liste les outils disponibles ;
- l'approbateur est le propriétaire lui-même ;
- le panneau ne demande ni le modèle ni les données : la capacité prend le fournisseur par défaut, l'URL Ollama locale sans modèle choisi (`packages/capabilities/src/llm.ts`). D'après le code, une exécution est alors refusée (`E_SCHEMA`) tant qu'aucun modèle n'est fixé ; ce comportement n'a pas été observé dans le panneau ;
- en profil privé, celui que crée l'app Mac, un serveur source MCP stdio est refusé (`E_DENIED`, `packages/capabilities/src/mcp-answer.ts`) : seul un serveur HTTP sur une origine privée autorisée peut être partagé.

Une annotation de lecture seule est déclarée par le serveur, pas vérifiée par drop. En ligne de commande, `share <agent>/<serveur> --tools a,b --approver <nodeId>` et `publish <capacité> --approver <nodeId> --config <fichier.json>` permettent de choisir les outils, l'approbateur et le modèle.

Le panneau ne permet pas encore de choisir les outils, le modèle ou l'approbateur : ce choix est porté par T4.16.

Un agent A2A d'entreprise se raccorde par une URL et des identifiants approuvés ; l'analyse locale ne découvre pas l'infrastructure d'entreprise.

Chaque carte de consentement du panneau dit qui demande et par quel agent, la question, pourquoi, ce que le demandeur recevra et ce qu'il ne recevra jamais, puis le coût s'il existe, l'expiration et la sensibilité ; « Pas maintenant » est le choix par défaut au clavier (T4.14). Accepter une demande ne donne pas un accès permanent. Voir [les critères AC-CONNECT](ACCEPTANCE.md) ; la landing montre une simulation, pas un installeur.
