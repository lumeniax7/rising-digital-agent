# Rising Digital Agent v4.4 — conseiller conversationnel

Agent IA autonome de **Rising Digital Solutions** (Agbelouvé, Togo) — publications sociales automatiques, assistant WhatsApp, CRM, mémoire, rapports quotidiens. **Coût visé : 0 USD tant que les quotas gratuits de Cloudflare suffisent** (Workers, D1 et Workers AI avec limites quotidiennes). Des dépassements ou options payantes peuvent nécessiter un paiement.

## Ce que fait l'agent
- **07h00 (Lomé)** : génère le post du jour (IA ou gabarit de repli), choisit le service (rotation équitable des 27 services), contrôle l'anti-répétition, met en file et publie.
- **Publication multi-canaux** : Facebook, Instagram — statut RÉEL par canal (succès uniquement sur confirmation de l'API, échec partiel visible, réconciliation avant nouvelle tentative, backoff exponentiel).
- **TikTok** : paquet prêt à publier + mention « publication manuelle requise » (l'API Content Posting exige une approbation — voir `docs/TIKTOK.md`). L'agent n'invente jamais une publication réussie.
- **WhatsApp** : webhook officiel (signature HMAC, déduplication), conseiller IA conversationnel multi-sujets (réponses naturelles, mémoire par contact, conseils pratiques), CRM automatique (contacts + prospects qualifiés), transfert humain uniquement lorsqu'il est demandé ou nécessaire.
- **v4.3 — autonomie étendue** : brèves de contexte du jour (1 appel IA le matin, injectées dans les réponses WhatsApp — jamais de fausse actualité) ; conseil structuré en 3 points (constat → méthode → premier pas) ; FAQ auto-apprenante (question posée 3+ fois → réponse instantanée sans IA) ; second post quotidien 16h00 avec hashtags automatiques du service ; alertes admin WhatsApp sur échec définitif de publication ; bilan hebdo enrichi des 3 sujets les plus demandés ; paquet de 3 statuts WhatsApp prêt à publier chaque matin (l'API Cloud ne permet pas la publication automatique de statuts — livré dans Rapports + WhatsApp admin).
- **WhatsApp v4.2 — agent renforcé** : contrôle des tarifs strict uniquement sur les demandes commerciales ; les réponses générales ne sont plus rejetées parce qu'elles contiennent un montant, un lien de référence ou une information ordinaire ; affiche du service détectée envoyée en image WhatsApp ; mémoire par contact (sujets et dernier besoin persistés, injectés dans le prompt) ; relances jamais envoyées entre 22h et 7h (reportées à 9h00, Lomé = UTC).
- **WhatsApp v4.4 — conseiller conversationnel** : répond d'abord à la demande réelle, y compris hors numérique ; aucune promotion obligatoire, aucune relance commerciale après une simple question générale ; modèles IA actifs Gemma 4 / GLM 4.7 Flash, remplacement des modèles retirés ; réponses rapides aux vraies questions (fini l'attente de 6 h pour une question sérieuse, l'anti-spam ne filtre plus que le bruit) ; relances automatiques après une pause (4–20 h selon le contexte, jamais après un refus, dans la fenêtre Meta de 24 h — au-delà, la relance passe en « modèle Meta requis » plutôt que d'envoyer illégalement). Voir `src/social/conversation.js` et `migrations/0003_followups.sql`.
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
| WhatsApp conseiller IA multi-sujets + CRM | ✅ opérationnel sous réserve d'un modèle Workers AI actif et de WhatsApp Cloud API |
| TikTok publication directe | ⏳ en attente d'approbation API — export manuel fourni |
| Rapports 07h30 / hebdo + alertes | ✅ opérationnel |
| Tableau de bord complet | ✅ opérationnel |
| Génération vidéo/image lourde | ❌ non intégré (aucune API gratuite fiable) — mode semi-automatique documenté |
| Publicité payante, abonnements | 🚫 bloqué par conception (aucune dépense non autorisée) |

## Architecture
Cloudflare Workers (API + cron) · D1 (données, isolation par client) · Workers AI (routeur multi-fournisseurs + quotas + repli) · assets statiques (SPA + 27 affiches). Détails : `docs/ARCHITECTURE.md`.

## Sécurité
Les secrets applicatifs restent dans Cloudflare Worker. Workers Builds publie depuis `main` après ses tests; GitHub Actions ne lance que les tests et ne requiert pas de jeton Cloudflare pour cette configuration. Aucun secret n’est committé ni écrit dans les journaux. Sessions PBKDF2 + CSRF + rate limiting. `.dev.vars` ignoré par Git. Voir `docs/VARIABLES.md`.
