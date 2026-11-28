# Architecture

```
            ┌────────────────────────── Cloudflare Worker ──────────────────────────┐
 WhatsApp ──▶ /webhook ──▶ whatsapp.js ──▶ CRM + mémoire + IA (chat_reply) ──▶ Meta │
 Meta/Graph ◀── social/{facebook,instagram}.js ◀── publish.js (états par canal)      │
 Dashboard ──▶ /api/* ──▶ web/router.js ──▶ auth PBKDF2/sessions/CSRF                │
 Cron 07h00 ─▶ generator.js (IA ou gabarit) ─▶ queue.js (jobs, backoff)              │
 Cron 07h30 ─▶ reports.js (rapport quotidien / hebdo) ─▶ webhook optionnel           │
            │        D1 : tenants, posts, post_channels, messages, leads,             │
            │        memory, ai_providers, ai_usage, events, reports, jobs            │
            └──────────────────────────────────────────────────────────────────────────┘
```

## Modules
| Module | Rôle |
|---|---|
| `core/` | config, utilitaires, crypto (PBKDF2/HMAC), schéma versionné, journal |
| `ai/` | routeur par tâche (write_post, chat_reply, idea, summarize) + quotas + adapter `providers/*.js` |
| `social/` | meta (Graph), facebook, instagram (statut conteneur réel), tiktok (export honnête), whatsapp, publish (orchestrateur) |
| `content/` | 27 services, moteur éditorial (rotation + anti-répétition Jaccard), générateur |
| `crm/` | contacts, prospects, qualification |
| `memory/` | mémoire par client (scopes brand/whatsapp/notes) |
| `tasks/` | file de jobs idempotente (dedupe_key, backoff, tentatives limitées) |
| `reports/` | agrégats quotidiens/hebdo + notification |
| `web/` | auth (PBKDF2, sessions, CSRF, rate limit), API, SPA statique |

## États d'une publication (post_channels)
`pending → queued → publishing → published | manual_required | error | unconfigured`
- `published` : **seulement** si l'API a renvoyé un identifiant vérifiable.
- `partial` (statut post) : au moins un canal confirmé + au moins un non-abouti — jamais compté comme succès.
- Réconciliation avant retry : recherche de la publication existante (Facebook feed / Instagram conteneur) pour éviter les doublons.
- Statut post dérivé des canaux (`core/state.js`), jamais écrit arbitrairement.

## Isolation multi-clients
Toutes les tables métier portent `tenant_id` ; toutes les requêtes filtrées. Prêt pour la SaaS-ification (voir ROADMAP).
