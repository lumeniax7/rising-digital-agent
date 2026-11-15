# Déploiement (GitHub + Cloudflare, 0 USD)

## 1. GitHub
```bash
# sur votre machine, depuis le dossier décompressé :
git init && git add -A && git commit -m "Rising Digital Agent v4"
gh repo create rising-digital-agent --private --source=. --push
# (ou via github.com : New repository "rising-digital-agent" → push existing)
```
## 2. Cloudflare Workers
1. Dashboard → Workers & Pages → **Create → Import a repository** → `rising-digital-agent`.
2. Vérifier `wrangler.toml` : `database_id` (D1 `rds-agent`), crons `0 7 * * *` et `30 7 * * *`.
3. `npm run db:init` (ou Dashboard → D1 → rds-agent → Console → coller `migrations/0001_init.sql`).
4. Settings → **Variables and Secrets** : ajouter les secrets de `docs/VARIABLES.md` (jamais de secret dans GitHub).
5. Déployer. **Ouvrir une fois l'URL du Worker** (connecte l'adresse publique des affiches) puis « Générer maintenant » pour vérifier.
6. Webhook WhatsApp : URL = `https://votre-worker.workers.dev/webhook`, jeton = `WA_VERIFY`, champ `messages`.

## 3. GitHub Actions (déploiement continu, gratuit)
Secrets GitHub requis : `CLOUDFLARE_API_TOKEN` (permission Workers Scripts:Edit + D1:Edit) et `CLOUDFLARE_ACCOUNT_ID`. Chaque push sur `main` lance les tests puis déploie. Aucun secret n'apparaît dans le dépôt.

## 4. Vérifications après déploiement
- Tableau de bord → Paramètres : coordonnées correctes.
- « Générer maintenant » → le post apparaît avec statut par canal honnête (canal non configuré = ⚪, jamais publié).
- WhatsApp : envoyer « bonjour » depuis un téléphone test → réponse automatique + prospect dans le CRM.
- Demain 07h30 : rapport visible dans Rapports.
