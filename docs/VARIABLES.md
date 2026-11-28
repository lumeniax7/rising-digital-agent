# Variables et secrets

## Variables applicatives non secrètes

Configurées dans `wrangler.toml` ou modifiables dans le tableau de bord (`meta`).

| Variable | Rôle | Défaut |
|---|---|---|
| `SITE_URL` | Site public par défaut; `meta.site_url` peut le remplacer | `https://risingdigitalsolutions.pages.dev` |
| `GRAPH_VERSION` | Version de l’API Graph Meta | `v23.0` |
| `MODE` | `test` / `approval` / `auto`; l’ancien `meta.mode` reste prioritaire | `auto` en production; `test` en local |
| `WA_COOLDOWN_H` | Délai anti-spam WhatsApp (heures) | `6` |
| `AI_DAILY_LIMIT` | Plafond global d’appels IA par jour | `200` |
| `IMAGE_BASE` | URL publique des affiches | URL du Worker |
| `ALLOWED_ORIGIN` | Origine autorisée pour les appels navigateur externes | `https://lumeniax7.github.io` |

## Secrets applicatifs d’exécution

À configurer dans **Cloudflare → Worker → Settings → Variables and Secrets**. Ne pas les committer dans Git ou les journaux.

| Secret | Rôle |
|---|---|
| `ADMIN_PASSWORD` | Obligatoire en production; accès au tableau de bord (12 caractères minimum). Une rotation met à jour le compte `admin` et révoque ses sessions. |
| `FB_PAGE_ID` + `FB_PAGE_TOKEN` | Publication Facebook Page |
| `IG_USER_ID` (`IG_TOKEN` optionnel) | Publication Instagram Business |
| `WA_TOKEN` + `WA_PHONE_ID` | WhatsApp Cloud API (envoi) |
| `WA_VERIFY` | Vérification du webhook (`hub.challenge`) |
| `WA_APP_SECRET` | Obligatoire pour accepter les POST webhook; vérifie la signature HMAC SHA-256 |
| `TIKTOK_TOKEN` | Opérations autorisées (voir `TIKTOK.md`) |

## Build et publication

La publication de production utilise **Cloudflare Workers Builds**, relié au dépôt GitHub sur la branche `main`. Le build de production exécute `npm ci && npm test`, puis `npm run deploy`. Les builds de Preview exécutent aussi les tests avant `npx wrangler preview`.

Les variables de build ne sont accessibles qu’aux commandes de build et ne deviennent pas des variables d’exécution du Worker. Ne placez donc pas les secrets applicatifs dans les variables de build; configurez-les dans les paramètres **Variables and Secrets** du Worker.

Le workflow GitHub Actions `.github/workflows/worker-ci.yml` exécute les tests sur les pull requests et les pushes vers `main`; il ne publie pas le Worker. Pour cette configuration, `CLOUDFLARE_API_TOKEN` et `CLOUDFLARE_ACCOUNT_ID` n’ont pas à être ajoutés aux secrets ou variables GitHub Actions. Workers Builds gère l’authentification auprès de Cloudflare.

Si la publication devait un jour être transférée à une CI externe, celle-ci nécessiterait un `CLOUDFLARE_API_TOKEN` en secret et un `CLOUDFLARE_ACCOUNT_ID` en variable ou secret. Il faudrait alors désactiver Workers Builds pour éviter deux voies de déploiement concurrentes et mettre à jour cette documentation.

## Paramètres modifiables dans le tableau de bord (`meta`)

`site_url`, `email`, `location`, `contact_phones`, `wa_cooldown_hours`, `report_webhook_url`. L’ancien réglage `meta.mode` reste prioritaire sur `MODE`; la source effective est affichée dans le tableau de bord.
