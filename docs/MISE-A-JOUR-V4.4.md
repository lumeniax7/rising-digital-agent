# Mise à jour de RISING DIGITAL AGENT vers v4.4

Ce paquet met à jour le dépôt existant. Il ne faut pas créer un nouveau Worker, une nouvelle base D1 ou un nouveau webhook WhatsApp.

## 1. Remplacer les fichiers du dépôt GitHub

1. Téléchargez l'archive `RISING-DIGITAL-AGENT-v4.4.zip` et décompressez-la sur votre ordinateur.
2. Ouvrez le dépôt GitHub existant `lumeniax7/rising-digital-agent`.
3. Dans la branche `main`, choisissez **Add file → Upload files**.
4. Ouvrez le dossier décompressé et sélectionnez tous les fichiers et dossiers qu'il contient (README, `src`, `tests`, `migrations`, `public`, `docs`, etc.). Il faut envoyer le contenu du dossier, pas créer un sous-dossier supplémentaire dans le dépôt.
5. Déposez les fichiers sur GitHub. Acceptez le remplacement des fichiers existants et conservez les fichiers qui ne sont pas modifiés.
6. Validez avec un message tel que `Rising Digital Agent v4.4 — conseiller conversationnel`.

Ne téléversez jamais vos secrets privés, votre fichier `.dev.vars` ou un fichier `.env`. Le paquet ne contient que `.dev.vars.example`.

## 2. Laisser Cloudflare déployer

Le dépôt existant est prévu pour Cloudflare Workers Builds. Après le commit sur `main`, Cloudflare doit lancer le build et le déploiement selon les paramètres déjà configurés.

Réglages attendus :

- Build : `npm ci && npm test`
- Déploiement : `npm run deploy`

Attendez que le déploiement Cloudflare soit terminé. Un commit GitHub ou un test GitHub vert ne prouve pas, à lui seul, que le Worker de production a été mis à jour.

## 3. Conserver les ressources existantes

Ne supprimez pas :

- le Worker `rising-digital-agent` ;
- la base D1 `rds-agent` ;
- les secrets WhatsApp, Meta et administrateur ;
- les paramètres du webhook Meta ;
- les déclencheurs programmés existants.

Au premier démarrage de la nouvelle version, le code met à jour les anciens modèles IA Llama vers Gemma 4 et GLM 4.7 Flash. Les états d'activation et les limites propres aux fournisseurs sont conservés. La migration SQL correspondante est aussi fournie dans `migrations/0004_ai_models.sql`.

## 4. Test WhatsApp conseillé

Depuis un numéro de test, envoyez ces messages séparément :

1. `Bonjour` — l'agent doit répondre naturellement, sans mini-quiz imposé.
2. `Combien d'habitants compte le Togo ?` — il doit traiter cela comme une question générale, pas comme une demande de devis.
3. `Pourquoi le ciel est-il bleu ?` — il doit expliquer le sujet, sans publicité.
4. `Comment créer un site web pour mon activité ?` — il doit donner des étapes utiles avant de présenter éventuellement le service correspondant.
5. `Je souhaite parler à un conseiller humain.` — la demande doit être enregistrée dans le CRM et une alerte à l'administrateur doit être tentée.

Vérifiez ensuite le tableau de bord et les journaux du Worker. Si l'IA ne répond pas, recherchez `wa_ia_indisponible` et vérifiez que Gemma 4 et GLM 4.7 Flash sont activés dans la rubrique Fournisseurs IA.

## 5. Limites

Workers AI offre un quota gratuit quotidien limité, pas un service illimité. Cette version n'intègre pas encore une recherche Internet en direct ; l'agent doit le dire honnêtement pour les actualités et les informations qui changent rapidement. Les messages WhatsApp libres et les relances restent soumis aux règles de la fenêtre de service Meta de 24 heures.
