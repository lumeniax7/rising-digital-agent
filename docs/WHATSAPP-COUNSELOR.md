# RISING DIGITAL AGENT — comportement du conseiller WhatsApp

## Objectif

RISING DIGITAL AGENT répond comme un conseiller compétent et naturel. Le classement local des messages aide à comprendre le contexte, mais ne doit jamais enfermer la personne dans un formulaire ou un parcours de vente.

## Règles de réponse

1. Répondre à la question réellement posée avant toute qualification.
2. Accepter les sujets généraux, même sans rapport avec les services de Rising Digital Solutions.
3. Adapter la longueur et le niveau d'explication à la demande ; une question complexe peut recevoir une réponse détaillée.
4. Poser au plus une question à la fois, uniquement si une précision est nécessaire.
5. Ne proposer un service que lorsqu'il répond au besoin exprimé.
6. Ne jamais prétendre qu'un humain a été contacté si le transfert n'a pas été déclenché.
7. Ne pas déclencher de relance commerciale après une question générale ou une demande de conseil.
8. Ne mémoriser dans la FAQ que les réponses liées à un service identifié, afin de limiter la conservation de réponses générales qui peuvent devenir obsolètes.

## Modèles IA par défaut

- Gemma 4 26B A4B : modèle principal pour les réponses, les idées et les résumés.
- GLM 4.7 Flash : modèle de repli pour les conversations et les publications.
- Whisper Large v3 Turbo : transcription des messages vocaux.

Les modèles sont configurés dans `src/core/db.js`. Au démarrage, les anciennes références Llama sont migrées vers les modèles actifs, sans réinitialiser les quotas ni les états `enabled` des fournisseurs existants.

## Limites à connaître

- Les modèles Workers AI ont un quota gratuit quotidien limité. Le fonctionnement n'est pas illimité et les appels peuvent échouer si le quota est épuisé ou si le service est indisponible.
- Le conseiller ne dispose pas d'une recherche Internet en direct intégrée dans cette version. Il ne doit donc jamais prétendre avoir vérifié une actualité, un prix du marché ou une information récente.
- Les demandes qui nécessitent un professionnel (santé, droit, finance, sécurité) doivent être traitées avec prudence.
- Un transfert humain reste disponible lorsque la personne le demande explicitement ou lorsqu'un sujet sensible le nécessite. Le prospect est enregistré dans le CRM, une alerte WhatsApp à l'administrateur est tentée, et le client n'est informé de l'alerte que si Meta confirme son envoi.
- Les messages WhatsApp libres sont soumis à la fenêtre de service de Meta ; les relances au-delà de 24 heures nécessitent un modèle approuvé.

## Contrôle après déploiement

1. Envoyer une question générale sans lien avec le numérique, par exemple : « Pourquoi le ciel est-il bleu ? ».
2. Vérifier que l'agent répond au sujet et ne propose pas un devis.
3. Poser une question de suivi pour vérifier la continuité de la conversation.
4. Demander un conseil numérique concret et vérifier qu'il fournit des étapes avant de proposer éventuellement un service.
5. Demander explicitement « Je souhaite parler à un conseiller humain » et vérifier que le transfert est déclenché.
6. Vérifier dans le journal que le modèle utilisé est Gemma 4 ou GLM 4.7 Flash et qu'aucune erreur de modèle retiré n'apparaît.
