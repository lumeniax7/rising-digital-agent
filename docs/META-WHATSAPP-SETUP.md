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

## Règles WhatsApp
- Réponses libres automatiques uniquement dans la fenêtre de service client de 24 h ouverte par le message entrant. Hors fenêtre, l’agent prépare un modèle approuvé, mais ne l’envoie que si l’option est activée, si Meta confirme `APPROVED` et si le consentement exigé est enregistré.
- Un message entrant n’est pas traité comme un consentement général aux messages promotionnels. Une demande explicite d’arrêt (par exemple `STOP`) suspend les réponses automatiques et modèles, ainsi que l’envoi manuel depuis le tableau de bord, jusqu’à la commande `REPRENDRE` envoyée par le contact.
- Une réponse manuelle dans le tableau de bord place la conversation en transfert humain avant l’envoi. Le bot ne reprend qu’après une reprise autorisée depuis le tableau de bord. Un message envoyé depuis l’application WhatsApp personnelle n’est pas garanti visible par le webhook Cloud API; seule l’intervention enregistrée dans le tableau de bord est détectée par ce contrôle.

## Distribution sociale et limites Meta

- La publication Facebook automatique concerne la Page reliée au jeton et aux autorisations adéquates. L’API officielle de publication sur Page utilise notamment `pages_manage_posts` et les tâches de Page requises.
- La publication automatique dans des groupes Facebook n’est pas prise en charge : les permissions et fonctions Facebook Groups API ont été retirées de toutes les versions le 22 avril 2024. Ne pas la remplacer par une connexion navigateur ou du scraping.
- WhatsApp Groups API est une capacité distincte, réservée aux comptes Official Business Account, sur invitation et limitée à huit participants. Elle n’est pas activée ici; vérifier l’éligibilité OBA, les webhooks et l’adhésion des membres avant toute conception d’intégration.
- L’agent ne publie pas de WhatsApp Status. Les documents officiels examinés ne confirment pas de route publique de publication de statut; ne pas simuler cette fonction par une automatisation de l’application.
- Les posts de Page dirigent vers le catalogue du site : `https://risingdigitalsolutions.pages.dev/#catalogue`. Pour partager dans un groupe, utiliser un brouillon puis une publication manuelle conforme aux règles du groupe.


## Modèle de reprise hors fenêtre de 24 h

Le Worker peut mettre les messages arrivés après l’expiration de la fenêtre de service dans `wa_template_queue`. Les anciens éléments `wa_inbox` en échec sans réponse sont copiés dans cette file par la migration `0003_wa_template_queue.sql`; leur statut `failed` d’origine n’est pas modifié et ils ne deviennent pas des messages libres en attente.

L’envoi du modèle `reprise_conversation_client` est désactivé tant que `WA_TEMPLATE_SEND_ENABLED` n’est pas exactement `true`. Il exige aussi `WA_WABA_ID`, `WA_PHONE_ID` et `WA_TOKEN`. Le Worker interroge Meta avant chaque envoi et ne continue que si un modèle unique correspond au nom exact, à la langue `fr`, à la catégorie `UTILITY`, au corps et aux paramètres `{{1}}`, `{{2}}`, avec statut `APPROVED`. Les erreurs de statut sont bloquantes; les erreurs d’envoi ambiguës nécessitent une revue humaine afin d’éviter un doublon automatique.

Avant activation, confirmer l’identifiant WABA dans WhatsApp Manager, le statut réel du modèle, le consentement documenté pour chaque destinataire et la disponibilité du nom client. Le champ CRM `contacts.consent` doit être égal à `1`; il n’est pas modifié automatiquement à la réception d’un message. En l’absence de destination `report_webhook_url`, la surveillance ne transmet aucune alerte à l’extérieur.

Aucun test local n’envoie de message réel. Ne mettre `WA_TEMPLATE_SEND_ENABLED` à `true` qu’après approbation Meta et revue explicite des destinataires admissibles.

## Blocage permanent d'un destinataire WhatsApp

Le destinataire explicitement exclu par le propriétaire est bloqué pour tout traitement et envoi automatiques par une liste permanente dans `src/social/whatsapp-recipient-policy.js`. Le numéro est comparé après normalisation (préfixe `00`, indicatif et séparateurs). Cette règle codée ne dépend pas de la présence de sa ligne dans D1; la table `wa_recipient_blocks` reste une protection complémentaire. La fonction d'envoi manuel reste distincte et n'est pas bloquée par cette règle.

Cette protection ne devient effective en production qu'après compilation et publication du Worker. Tant que la version publiée n'inclut pas ce code, le Worker actif peut continuer à traiter les messages.

## Réponses conversationnelles et indisponibilité IA

Le bot reçoit les 12 derniers échanges, applique le profil de marque et doit répondre au dernier message sans répéter son accueil, inventer des faits ou promettre un engagement non vérifié. Le routeur IA contourne désormais, pour le reste de la journée UTC, un fournisseur qui a effectué au moins trois appels avec un taux d'erreur d'au moins 50 %, afin de préserver le quota pour un fournisseur de repli.

Si aucun fournisseur n'est disponible ou si le plafond global est atteint, le Worker signale l'indisponibilité une seule fois par conversation, marque celle-ci pour reprise humaine, puis n'envoie plus la réponse générique à chaque nouveau message. Le plafond est défini par `AI_DAILY_LIMIT`; son augmentation peut accroître l'usage et les coûts et doit être décidée séparément. Ces protections n'affectent la production qu'après publication du Worker.
