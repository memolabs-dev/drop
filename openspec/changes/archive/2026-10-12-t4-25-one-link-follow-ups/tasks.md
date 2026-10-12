## 1. Documentation d'abord

- [x] 1.1 Versions verrouillées (`Cargo.lock`, `scripts/build-desktop.ts`) et pages Tauri « Deep Linking » et « Single Instance » ; sources de `tauri-plugin-single-instance` 2.5.3, `tauri-plugin-deep-link` 2.6.1 et `tauri-bundler` 2.10.1.
- [x] 1.2 Bilan de la PR #45 dans `main.rs` et `Cargo.toml` : instance unique faite, AppImage non enregistrée.
- [x] 1.3 État du site en ligne (`curl -sI https://drop.memolabs.dev/join`) : 404 sous `script-src 'none'`.

## 2. Tests d'abord

- [x] 2.1 Panneau : lien https d'« Inviter » copié tel quel (`menu bar panel (T4.31)`), test de T2.4 adapté au lien https.
- [x] 2.2 Panneau : « Connecter mes agents » après « Rejoindre », analyse sans raccordement, « Plus tard ».
- [x] 2.3 Coque : instance unique en premier plugin, `register_all` depuis une AppImage, `E_DEEP_LINK` (`test/desktop-join-link.test.ts`).
- [x] 2.4 Site : `site-headers.json` à côté de l'export (`test/join-page.test.ts`).

## 3. Réalisation

- [x] 3.1 `packages/desktop-ui/src/panel/team.tsx` : lien `link`.
- [x] 3.2 `deep-links.tsx`, `PanelApp.tsx`, `tools.tsx` : carte « Prochaine étape », analyse demandée à « Mes outils ».
- [x] 3.3 Module généré du panneau régénéré par `scripts/build-desktop-ui.ts`.
- [x] 3.4 `apps/desktop/src-tauri/src/main.rs` : `register_all` depuis une AppImage.
- [x] 3.5 `scripts/site.ts` : `site-headers.json`.
- [x] 3.6 Docs : `ONBOARDING.md`, `RELEASE.md`, `deploiement-lab.md`, `site/demarrer.html`.

## 4. Vérification

- [x] 4.1 `pnpm -r lint && pnpm -r typecheck && pnpm -r test`, `build-desktop-ui.ts --check`, `openspec validate --strict`, openspec-guard, `cargo check`, revue du diff.
