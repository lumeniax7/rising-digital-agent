# TikTok — état honnête

La **publication directe** nécessite l'API **Content Posting API** avec une **approbation TikTok** (audit de l'app, compte conforme). Tant que cette autorisation n'existe pas :
- l'agent produit un **paquet prêt à publier** (texte, hashtags, format 9:16, note) visible dans la vue Publications ;
- le canal TikTok affiche `manual_required` — **publication manuelle requise** ;
- l'agent n'indiquera **jamais** qu'une vidéo TikTok a été publiée sans confirmation de TikTok.

Parcours d'obtention : TikTok for Developers → app → demander Content Posting API (products) → audit → `video.upload`. Une fois approuvé, créer `social/tiktok_direct.js` et basculer le canal (l'architecture est déjà extensible).
