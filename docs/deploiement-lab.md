# Exploitation publique : relais et site

Ce que drop fait tourner en public sous `drop.memolabs.dev`, comment vérifier que ça répond, et comment héberger son propre relais. Le relais public tourne derrière un reverse proxy sur un VPS, déployé depuis un dépôt d'infrastructure privé ; ce dépôt n'en décrit pas les détails.

## Ce qui tourne

- **Le relais** : `wss://drop.memolabs.dev/v1`, avec sa sonde `https://drop.memolabs.dev/health`. Il admet les Nodes par invitation (T2.1) et applique les révocations sans redémarrage (T2.19, D75).
- **Le site** : `https://drop.memolabs.dev/`, un export statique des pages de `site/`, servi sans privilèges et sans accès au dépôt, aux clés ni aux données des Nodes. L'export en ligne date de la publication du 8 octobre 2026 (T2.6b) : les pages corrigées depuis ne sont en ligne qu'au prochain export. La page pour rejoindre (`/join`, T4.23) est la seule à script : l'hébergement doit lui envoyer sa propre politique de contenu au lieu de `script-src 'none'`. `node scripts/site.ts build` l'écrit, à côté de l'export et hors des fichiers publiés, dans `dist/site-headers.json` (`default` pour toutes les pages, `paths` pour `/join`, `/join/`, `/join.html` et `/join/index.html`) ; l'empreinte du script change à chaque modification de la page, il faut donc la relire à chaque export (T4.31).
- **L'image** du relais et du site : `ghcr.io/memolabs-dev/drop`, construite par la CI sur des runners hébergés par GitHub. Chaque commit sur `main` publie `:<sha complet>`, `:main` et `:latest` (tiré automatiquement par le déploiement ; `latest` ne vient jamais d'un tag ni d'une pull request), chaque tag `v*` ses tags semver. SBOM et attestation de provenance : `gh attestation verify oci://ghcr.io/memolabs-dev/drop:latest -R memolabs-dev/drop`.
- **Les mises à jour de l'app Mac** : servies sous `https://drop.memolabs.dev/updates/` quand une version est publiée (D70). La procédure de publication est dans [MAC_RELEASE](MAC_RELEASE.md).

La passerelle grand public (`https://drop.memolabs.dev/mcp`, T2.13, D31) n'est pas un parcours produit : le profil privé refuse la liaison et une politique d'entreprise peut interdire toute passerelle. C'est une option cloud à réévaluer après la preuve privée (T3.5).

## Vérifier l'état

```sh
curl -s https://drop.memolabs.dev/health                # relais : {"ok":true,"nodes":1,"build":"<sha>"}
curl -sI https://drop.memolabs.dev/                     # site : 200
curl -sI https://drop.memolabs.dev/updates/latest.json  # 404 tant qu'aucune version n'est publiée
```

`build` est le commit dont l'image a été construite (D91) : `git ls-remote origin <sha>` dit si c'est celui que vous
entendez faire tourner. `unknown` signifie qu'aucun commit n'a été inscrit à la construction ; `nodes` est le nombre de
Connections en place, pas le nombre de membres admis. La sonde ne dit jamais « à jour » : elle donne le fait, la
comparaison vous appartient.

Puis, depuis un Mac : `drop invite` chez un membre et `drop pair` chez un nouveau venu absent de l'allowlist (T2.1).

## Héberger son propre relais

Le relais public n'est pas obligatoire. Les postes se joignent aussi par le réseau local ou par iroh, et une équipe peut faire tourner son propre relais (voir [le guide](GUIDE.md) et [le profil privé](PRIVATE_PROFILE.md)).

- **Image Docker** : `docker build -f docker/relay.Dockerfile -t drop-relay .` depuis la racine du dépôt ([docker/relay.Dockerfile](../docker/relay.Dockerfile)). L'image tourne en utilisateur non root, avec une vérification `/health` ; monter `/data` en lecture-écriture pour les admissions et les révocations, la racine en lecture seule, et la configuration dans `/config/relay.config.json`.
- **Chart Helm** : [deploy/helm/drop-relay](../deploy/helm/drop-relay/), un réplica, volume persistant pour les admissions et les révocations, politique d'organisation et TLS facultatifs. Les valeurs commentées sont dans [values.yaml](../deploy/helm/drop-relay/values.yaml) (T4.10, D81).

Dans `relay.config.json`, tout état que le relais écrit doit vivre sur un volume persistant, sinon il oublie les Nodes admis à chaque redéploiement (D69) :

```json
{
  "admittedPath": "/data/admitted.json",
  "revokedPath": "/data/revoked.json",
  "maxAdmissionsPerSponsorPerDay": 20,
  "maxAdmissionsPerDay": 100
}
```

Avec `revokedPath`, révoquer un Node ne demande aucun redémarrage : le relais en marche applique la révocation en quelques secondes. `--with-invited` révoque aussi les Nodes qu'il a fait admettre.

```sh
drop-relay revoke <nodeId> [--with-invited] --config=/config/relay.config.json
```

Dans l'image du relais, la même commande s'écrit `node drop-relay.mjs revoke …`.
