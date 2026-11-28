# Déploiement (GitHub + Cloudflare, quotas gratuits limités)

## 1. Dépôt GitHub

```bash
git init && git add -A && git commit -m "Rising Digital Agent v4"
gh repo create rising-digital-agent --private --source=. --push
```

Vous pouvez aussi créer le dépôt depuis github.com puis pousser le dépôt existant.

## 2. Cloudflare Workers Builds : publication unique

Le Worker `rising-digital-agent` est relié au dépôt GitHub `lumeniax7/rising-digital-agent`, branche `main`. Dans Cloudflare → Workers & Pages → `rising-digital-agent` → **Settings → Builds**, vérifier les réglages suivants :

- **Production build command** : `npm ci && npm test`
- **Production deploy command** : `npm run deploy`
- **Preview build command** : `npm ci && npm test`
- **Preview command** : `npx wrangler preview`

Ainsi, Cloudflare exécute les tests avant `wrangler deploy` sur `main`. Workers Builds gère l’authentification de déploiement; aucun identifiant Cloudflare n’est requis dans les secrets GitHub Actions pour cette configuration. Ne configurez pas un second `wrangler deploy` dans GitHub Actions.

Pour une nouvelle installation, initialiser le schéma D1 une seule fois avec `npm run db:init` ou la console D1. Pour une mise à jour d'une installation existante, ne créez pas une nouvelle base : conservez la base D1 et les secrets. Le Worker applique les adaptations de schéma et migre les anciennes références de modèles IA lors de son initialisation. Vérifier dans `wrangler.toml` l’identifiant D1 `rds-agent` et les crons.

Dans le Worker → Settings → **Variables and Secrets**, ajouter les secrets applicatifs listés dans `docs/VARIABLES.md`. Ils servent à l’exécution du Worker; ils ne sont ni des identifiants de build ni des secrets GitHub Actions.

Webhook WhatsApp : URL `https://votre-worker.workers.dev/webhook`, jeton `WA_VERIFY`, champ `messages`.

## 3. GitHub Actions : tests seulement

Le workflow `.github/workflows/worker-ci.yml` exécute `npm ci` et `npm test` sur les pull requests et les pushes vers `main`. Il ne déploie pas le Worker. La publication est uniquement assurée par Workers Builds et s’exécute après la réussite de `npm test` dans son `build_command`.

## 4. Vérifications après déploiement

- Vérifier dans l’historique Workers Builds que le build du commit attendu a réussi.
- Vérifier dans Cloudflare → Worker → **Deployments** qu’une nouvelle version est active. Une exécution GitHub Actions verte seule ne prouve pas qu’un déploiement a eu lieu.
- Connexion au tableau de bord : `ADMIN_PASSWORD` doit être défini dans Cloudflare (12 caractères minimum). Ne le supprimez pas pour récupérer l’accès.
- Tableau de bord → Paramètres : vérifier les coordonnées.
- « Générer maintenant » : le post apparaît avec un statut honnête par canal.
- WhatsApp : envoyer un message depuis un téléphone de test puis vérifier la réponse et le prospect CRM.
- Consulter le journal après un test contrôlé; le cron reprend les traitements échoués toutes les 15 minutes.
- Vérifier le rapport dans Rapports après son exécution programmée.
