# Preuves T4.31

Exécutées le 12 octobre 2026 sur la branche `t4-25-one-link-follow-ups` (nom de change donné par la ligne T4.31), macOS (Apple Silicon), Node 24.21.0, Rust 1.99.0.

| Vérification | Résultat |
| --- | --- |
| `pnpm -r lint && pnpm -r typecheck && pnpm -r test` | vert : 92 fichiers de test (1 ignoré), 680 tests (1 ignoré, déjà ignoré sur `main`) |
| `node --experimental-strip-types scripts/build-desktop-ui.ts --check` | vert après régénération par le script (`E_WORKSPACE_STALE` avant) |
| `openspec validate t4-25-one-link-follow-ups --strict`, puis `openspec validate --all --strict` après archivage | valide ; 20 éléments valides |
| `openspec-guard@0.3.0 check --require-selector --baseline … --fail-on fail` | vert : 476 critères liés (472 sur `main`, + 4), 1 critère manuel de plus ; `--update-baseline` ne change pas la baseline |
| `TAURI_CONFIG='{"bundle":{"resources":[]}}' cargo clippy --all-targets --locked` dans `apps/desktop/src-tauri` | aucun avertissement, sous macOS seulement : le bloc `cfg(target_os = "linux")` n'y est pas compilé, la CI `release.yml` le construit sur la PR |

Les tests nouveaux ont d'abord échoué sur le code de `main` (lien `drop://pair` affiché, aucune « Prochaine étape », `register_all` absent, `site-headers.json` absent), puis sont passés.

## Critères et tests

| Critère | Test |
| --- | --- |
| Lien https à envoyer, copié tel quel, sans `drop://pair` | `menu bar panel (T4.31) > gives the https join link to send, never drop://pair` |
| « Connecter mes agents » après « Rejoindre », relais adopté nommé comme texte, analyse sans raccordement, « Plus tard » | `menu bar panel (T4.31) > offers Connecter mes agents after Rejoindre, then analyses this computer on one click` |
| Instance unique en premier plugin, liens par `open_links`, `register_all` depuis une AppImage avec `E_DEEP_LINK` | `desktop single instance (T4.31) > hands a drop:// link to the running app on Windows and Linux, and registers the scheme from an AppImage` |
| `site-headers.json` à côté de l'export, égal à ce que `serve` envoie | `join page (T4.31) > writes the join page policy next to the static export, outside the published files` |

## Non prouvé ici

- Lien ouvert pendant que l'app tourne, sur un vrai Windows 10 ou 11 et un vrai Ubuntu (AppImage et `.deb`) : scénario manuel, banc maison T4.6c.
- `/join` en ligne : la configuration nginx du VPS vit dans le dépôt d'infrastructure ; le 12 octobre, `https://drop.memolabs.dev/join` répond 404 sous `script-src 'none'`.
