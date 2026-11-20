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
2. Vérifier `wrangler.toml` : `database_id` (D1 `rds-agent`), les deux crons quotidiens et le cron de reprise toutes les 15 minutes.
3. `npm run db:init` (ou Dashboard → D1 → rds-agent → Console → coller `migrations/0001_init.sql`).
4. Settings → **Variables and Secrets** : ajouter les secrets de `docs/VARIABLES.md` (jamais de secret dans GitHub).
5. Déployer. **Ouvrir une fois l'URL du Worker** (connecte l'adresse publique des affiches), vérifier la connexion admin, puis utiliser uniquement des numéros et comptes de test.
6. Webhook WhatsApp : URL = `https://votre-worker.workers.dev/webhook`, jeton = `WA_VERIFY`, champ `messages`.

## 3. GitHub Actions (tests et déploiement)
Ajouter comme secrets du dépôt `CLOUDFLARE_API_TOKEN` (permission Workers Scripts:Edit; D1:Edit seulement si une migration distante est explicitement lancée) et `CLOUDFLARE_ACCOUNT_ID`. Les pull requests exécutent `npm ci` et `npm test`; un push validé sur `main` déploie si ces identifiants existent, sinon l’étape de déploiement est explicitement ignorée. Ne jamais mettre les secrets applicatifs Meta, WhatsApp ou `ADMIN_PASSWORD` dans GitHub : ils restent dans Cloudflare Variables and Secrets. Le workflow ne lance pas de migration D1 distante automatiquement.

## 4. Vérifications après déploiement
- Connexion au tableau de bord : `ADMIN_PASSWORD` doit être défini dans Cloudflare (12 caractères minimum). L'absence du secret ferme l'API; ne pas le supprimer pour récupérer l'accès.
- Tableau de bord → Paramètres : coordonnées correctes.
- « Générer maintenant » → le post apparaît avec statut par canal honnête (canal non configuré = ⚪, jamais publié).
- WhatsApp : envoyer « bonjour » depuis un téléphone test → réponse automatique + prospect dans le CRM.
- Les messages WhatsApp en échec et publications échues sont repris par le cron toutes les 15 minutes; vérifier le journal après un test contrôlé.
- Demain 07h30 : rapport visible dans Rapports.
