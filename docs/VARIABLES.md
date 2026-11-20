# Variables et secrets

## Vars (non secrètes, `wrangler.toml` ou table `meta` éditable dans le dashboard)
| Variable | Rôle | Défaut |
|---|---|---|
| `SITE_URL` | site public par défaut; `meta.site_url` peut le remplacer | https://risingdigitalsolutions.pages.dev |
| `GRAPH_VERSION` | version de l'API Graph Meta | v23.0 — **à vérifier** sur developers.facebook.com/docs/graph-api/changelog |
| `MODE` | test / approval / auto; `meta.mode` historique, s'il existe, est prioritaire | auto en production; test en local (`.dev.vars.example`) |
| `WA_COOLDOWN_H` | délai anti-spam WhatsApp (heures) | 6 |
| `AI_DAILY_LIMIT` | plafond global d'appels IA par jour (y compris les tentatives de repli) | 200 |
| `IMAGE_BASE` | URL publique des affiches (optionnel) | mémorisée à la 1ʳᵉ visite du dashboard |

## Secrets (Cloudflare > Variables and Secrets — JAMAIS dans GitHub ni dans le chat)
| Secret | Rôle |
|---|---|
| `ADMIN_PASSWORD` | obligatoire en production; connexion dashboard (12 caractères minimum). Sans ce secret, l'API métier reste fermée. Une rotation met à jour le compte `admin` et révoque ses sessions. |
| `FB_PAGE_ID` + `FB_PAGE_TOKEN` | publication Facebook Page |
| `IG_USER_ID` (+ `IG_TOKEN` optionnel) | publication Instagram Business |
| `WA_TOKEN` + `WA_PHONE_ID` | WhatsApp Cloud API (envoi) |
| `WA_VERIFY` | vérification du webhook (GET hub.challenge) |
| `WA_APP_SECRET` | obligatoire pour accepter les POST webhook; vérifie la signature HMAC SHA-256 |
| `TIKTOK_TOKEN` | réservé aux opérations autorisées (voir TIKTOK.md) |

## Paramètres modifiables dans le dashboard (table `meta`)
site_url, email, location, contact_phones, wa_cooldown_hours, report_webhook_url. Les anciens enregistrements `meta.mode` ont priorité sur `MODE`; la source effective est affichée sur le dashboard.
