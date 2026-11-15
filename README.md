# Rising Digital Agent v4

Agent IA autonome de **Rising Digital Solutions** (Agbelouvé, Togo) — publications sociales automatiques, assistant WhatsApp, CRM, mémoire, rapports quotidiens. **Budget : 0 USD** (Cloudflare Workers gratuit + D1 gratuit + Workers AI quota gratuit).

## Ce que fait l'agent
- **07h00 (Lomé)** : génère le post du jour (IA ou gabarit de repli), choisit le service (rotation équitable des 27 services), contrôle l'anti-répétition, met en file et publie.
- **Publication multi-canaux** : Facebook, Instagram — statut RÉEL par canal (succès uniquement sur confirmation de l'API, échec partiel visible, réconciliation avant nouvelle tentative, backoff exponentiel).
- **TikTok** : paquet prêt à publier + mention « publication manuelle requise » (l'API Content Posting exige une approbation — voir `docs/TIKTOK.md`). L'agent n'invente jamais une publication réussie.
- **WhatsApp** : webhook officiel (signature HMAC, déduplication), assistant IA conversationnel (profil de marque en mémoire), CRM automatique (contacts + prospects qualifiés), transfert humain pour les demandes sensibles.
- **07h30 (Lomé)** : rapport quotidien (hebdomadaire le lundi), stocké + notification optionnelle (webhook gratuit type ntfy.sh).
- **Tableau de bord** : SPA française sécurisée (PBKDF2, sessions, CSRF, rate limiting) — publications, calendrier, conversations, CRM, bibliothèque, mémoire, fournisseurs IA, journal, paramètres.

## Démarrage rapide
```bash
npm install
npm run db:init          # crée le schéma dans D1 (une fois)
npm run dev              # local (renseignez .dev.vars depuis .dev.vars.example)
```
Voir **docs/DEPLOYMENT.md** pour la mise en production (GitHub + Cloudflare) et **docs/VARIABLES.md** pour la liste exacte des variables et secrets.

## Tests
```bash
npm test    # node --test : machine à états, anti-répétition, webhook WhatsApp, routeur IA, repli gabarit
```

## Ce qui est opérationnel / en attente / indisponible
| Fonction | État |
|---|---|
| Génération + programmation des posts (IA + repli gabarit) | ✅ opérationnel |
| Facebook / Instagram (publication réelle avec confirmation) | ✅ opérationnel (nécessite jetons Meta) |
| WhatsApp assistant + CRM | ✅ opérationnel (nécessite WhatsApp Cloud API) |
| TikTok publication directe | ⏳ en attente d'approbation API — export manuel fourni |
| Rapports 07h30 / hebdo + alertes | ✅ opérationnel |
| Tableau de bord complet | ✅ opérationnel |
| Génération vidéo/image lourde | ❌ non intégré (aucune API gratuite fiable) — mode semi-automatique documenté |
| Publicité payante, abonnements | 🚫 bloqué par conception (aucune dépense non autorisée) |

## Architecture
Cloudflare Workers (API + cron) · D1 (données, isolation par client) · Workers AI (routeur multi-fournisseurs + quotas + repli) · assets statiques (SPA + 27 affiches). Détails : `docs/ARCHITECTURE.md`.

## Sécurité
Aucun secret dans le code, GitHub ou les journaux (masquage systématique). Sessions PBKDF2 + CSRF + rate limiting. `.dev.vars` ignoré par Git. Voir `docs/VARIABLES.md`.
