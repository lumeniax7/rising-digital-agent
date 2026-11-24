# Corrections de l’agent Rising Digital Solutions

## Publications Facebook

Les posts générés dirigent maintenant vers le catalogue demandé : `https://risingdigitalsolutions.pages.dev/#catalogue`. Le prompt s’appuie sur le service réellement sélectionné, privilégie un conseil utile et interdit les résultats inventés, les fausses urgences et les promesses garanties. La publication automatique existante vise une Page Facebook; elle dépend encore des autorisations et tâches de Page Meta, notamment `pages_manage_posts` [1].

L’API Facebook Groups n’est pas une alternative disponible : Meta a retiré ses permissions et fonctionnalités de toutes les versions le 22 avril 2024 [2]. Le partage de groupes doit donc rester manuel à partir d’un brouillon. WhatsApp Groups est un produit différent, réservé aux comptes officiels éligibles et limité à huit participants; cette intégration n’est ni vérifiée ni activée ici [3] [4].

## Assistant WhatsApp et contrôle humain

Le modèle reçoit les 12 derniers échanges et les descriptions du catalogue D1. Il doit répondre d’abord à la demande, présenter au plus un service lorsqu’il est pertinent, partager le lien seulement s’il aide le contact et ne pas se faire passer pour le fondateur. Les prix, délais, garanties et résultats ne sont pas fournis comme faits vérifiés.

Une réponse envoyée depuis le tableau de bord active le transfert humain avant l’appel réseau. Une vérification après génération empêche l’IA d’envoyer une réponse si le transfert a été activé pendant son traitement. La commande explicite `STOP` persiste en D1 et bloque les réponses automatiques, les modèles et les réponses manuelles depuis le tableau de bord. Seul le contact peut la lever en envoyant `REPRENDRE`. Sans demande STOP, l’administrateur peut reprendre le bot explicitement depuis le tableau de bord. Une intervention envoyée depuis l’application WhatsApp personnelle n’est pas garantie visible par le webhook Cloud API et ne déclenche donc pas cette pause.

La file des modèles hors fenêtre abandonne un ancien rappel quand un message plus récent du contact est arrivé ou qu’un transfert humain/opt-out est actif. Le statut du modèle est relu auprès de Meta avant chaque envoi; l’indicateur `WA_TEMPLATE_SEND_ENABLED` reste `false`. WhatsApp exige l’opt-in avant les messages concernés et réserve les messages libres à la fenêtre de service de 24 heures; hors fenêtre, seuls les modèles approuvés conviennent [5] [6]. Les envois indésirables peuvent entraîner des restrictions [7].

L’agent ne publie pas de WhatsApp Status. Les documents officiels examinés ne confirment pas une route publique de publication de statut; cette fonction n’est pas simulée par automatisation de l’application.

## Vérification et déploiement

Les contrôles statiques de syntaxe JavaScript, de JSON du catalogue et de whitespace ont réussi. Aucun test automatisé n’a été lancé. Aucun message WhatsApp réel, post Facebook ou déploiement Cloudflare n’a été effectué. Les identifiants et secrets existants n’ont pas été remplacés.

La configuration existante indique `MODE="auto"`, un cron quotidien de génération/publication à 07 h UTC et une reprise des publications en attente toutes les 15 minutes. Déployer le code en production pourrait donc publier du contenu public au prochain cron; cette étape doit être confirmée séparément. Le workflow GitHub exécute `npm test` seulement pour un push vers `main` ou une pull request vers `main`; aucune de ces actions n’a été faite.

## Références

[1]: https://developers.facebook.com/documentation/pages-api/posts "Meta Pages API posts"
[2]: https://developers.facebook.com/documentation/development/graph-api/changelog/version19.0 "Meta Graph API v19 changelog"
[3]: https://developers.facebook.com/documentation/business-messaging/whatsapp/groups "Meta WhatsApp Groups API"
[4]: https://developers.facebook.com/documentation/business-messaging/whatsapp/groups/get-started "Meta WhatsApp Groups API get started"
[5]: https://developers.facebook.com/documentation/business-messaging/whatsapp/getting-opt-in "Meta WhatsApp opt-in"
[6]: https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/send-messages "Meta WhatsApp service messages"
[7]: https://developers.facebook.com/documentation/business-messaging/whatsapp/policy-enforcement "Meta WhatsApp policy enforcement"
