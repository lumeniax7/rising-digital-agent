# Lots de travail pour Claude (si développement assisté)

Chaque lot est indépendant et vérifiable. Ordre recommandé :
1. **Audit du déploiement** : vérifier `database_id` D1, crons, secrets présents ; smoke test /health et /api/health.
2. **Connecteurs sociaux en conditions réelles** : jetons de test Meta, publication test sur Page/IG de test, vérifier les états par canal et la réconciliation.
3. **WhatsApp Cloud API** : numéro de test, webhook + HMAC, scénarios (accueil, devis, réclamation → transfert humain).
4. **TikTok** : demande d'approbation Content Posting API ; à l'obtention, implémenter `social/tiktok_direct.js` (upload direct) avec confirmation stricte.
5. **Routeur IA** : ajouter un 2ᵉ fournisseur gratuit réel (ex. un adaptateur open source auto-hébergé) et vérifier le basculement de quota.
6. **Multi-clients** : UI de gestion des tenants (la base est prête) + tests d'isolation.
7. **Analytics** : ingestion des insights Meta réellement disponibles et affichage.

Critère de fin de chaque lot : `npm test` vert + scénario manuel documenté + aucune régression des états de publication.
