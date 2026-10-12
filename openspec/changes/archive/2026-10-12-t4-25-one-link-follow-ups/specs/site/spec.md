## ADDED Requirements

### Requirement: Politique de la page pour rejoindre pour un hébergement statique
`node scripts/site.ts build` SHALL écrire, à côté du dossier exporté et jamais dedans, `site-headers.json` : la politique de contenu par défaut et, pour chaque chemin de la page pour rejoindre (`/join`, `/join/`, `/join.html`, `/join/index.html`), la politique à envoyer en en-tête, celle que `serve` envoie, `frame-ancestors 'none'` compris. Un hébergement statique MUST pouvoir l'appliquer sans recalculer l'empreinte du script (T4.31).

#### Scenario: AC: politique exportée hors des fichiers publiés
<!-- openspec-guard:test="join page (T4.31) > writes the join page policy next to the static export, outside the published files" -->
- **WHEN** le site est construit dans un dossier
- **THEN** `site-headers.json` est écrit à côté de ce dossier, donne pour chaque chemin de `/join` la politique que `serve` envoie et pour le reste `script-src 'none'`, et aucun fichier publié ne le contient
