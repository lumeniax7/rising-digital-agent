# Configuration Meta (Facebook, Instagram, WhatsApp)

## Comptes requis
- Page Facebook professionnelle + compte Instagram **Business** lié à la Page.
- Application Meta (type Business) + WhatsApp Business Platform (numéro dédié, pas votre WhatsApp personnel).

## Jetons
1. Générateur de jetons : permissions `pages_manage_posts`, `pages_read_engagement`, `instagram_content_publish`, `whatsapp_business_messaging`, `whatsapp_business_management`.
2. Jeton longue durée (60 jours) → renouveler avant expiration (l'agent journalise `token` en erreur HTTP 190).
3. Secrets dans Cloudflare : `FB_PAGE_TOKEN`, `FB_PAGE_ID`, `IG_USER_ID`, `WA_TOKEN`, `WA_PHONE_ID`, `WA_VERIFY`, `WA_APP_SECRET`.

## Webhook WhatsApp
- URL de rappel : `https://votre-worker.workers.dev/webhook` — Vérifier : valeur de `WA_VERIFY` — champ : `messages`.
- La signature HMAC (`WA_APP_SECRET`) est validée à chaque POST ; les messages répétés sont dédupliqués par `wamid`.

## Règles respectées par l'agent
- Réponses automatiques **uniquement** aux messages entrants (fenêtre service client 24 h).
- Pas de diffusion promotionnelle, pas de Statuts via l'API (non couvert par l'offre gratuite).
- Consentement enregistré côté CRM ; transfert humain pour litiges/réclamations.
