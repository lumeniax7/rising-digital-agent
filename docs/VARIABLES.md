# Variables et secrets

## Vars (non secrètes, `wrangler.toml` ou table `meta` éditable dans le dashboard)
| Variable | Rôle | Défaut |
|---|---|---|
| `SITE_URL` | site public de l'entreprise | https://risingdigitalsolutions.pages.dev |
| `GRAPH_VERSION` | version de l'API Graph Meta | v23.0 — **à vérifier** sur developers.facebook.com/docs/graph-api/changelog |
| `MODE` | test / approval / auto | test |
| `WA_COOLDOWN_H` | délai anti-spam WhatsApp (heures) | 6 |
| `AI_DAILY_LIMIT` | garde-fou d'appels IA/jour | 200 |
| `IMAGE_BASE` | URL publique des affiches (optionnel) | mémorisée à la 1ʳᵉ visite du dashboard |

## Secrets (Cloudflare > Variables and Secrets — JAMAIS dans GitHub ni dans le chat)
| Secret | Rôle |
|---|---|
| `ADMIN_PASSWORD` | connexion dashboard (12 car. min) — l'utilisateur `admin` est créé au premier lancement |
| `FB_PAGE_ID` + `FB_PAGE_TOKEN` | publication Facebook Page |
| `IG_USER_ID` (+ `IG_TOKEN` optionnel) | publication Instagram Business |
| `WA_TOKEN` + `WA_PHONE_ID` | WhatsApp Cloud API (envoi) |
| `WA_VERIFY` | vérification du webhook (GET hub.challenge) |
| `WA_APP_SECRET` | signature HMAC des webhooks (fortement recommandé) |
| `TIKTOK_TOKEN` | réservé aux opérations autorisées (voir TIKTOK.md) |

## Paramètres modifiables dans le dashboard (table `meta`)
site_url, email, location, contact_phones (3 numéros actuels), wa_cooldown_hours, report_webhook_url (optionnel, ex. canal ntfy.sh gratuit), mode.
