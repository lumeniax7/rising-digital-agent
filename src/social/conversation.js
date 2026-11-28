// Moteur de conversation v4.4 — conseiller multi-sujets, mémoire, qualification respectueuse, relances,
// filtre anti-hallucination, mémoire par contact, envois de jour uniquement.
// Principes : (1) le classement du message est local et gratuit (aucun appel IA supplémentaire) ;
// (2) honnêteté absolue — jamais de prix, délai ou information inventés, "je ne sais pas" autorisé ;
// (3) l'existant (webhook, CRM, handoff humain, anti-spam, quotas IA) reste inchangé : on s'y branche.

import { nowISO } from "../core/util.js";
import { log } from "../core/log.js";
import { runAI } from "../ai/router.js";
import { getMemory, setMemory } from "../memory/memory.js";

const SITE_DEFAULT = "https://risingdigitalsolutions.pages.dev";

// Ponts sujet -> service du catalogue (titres EXACTS de src/content/services.json, donc réels).
const TOPICS = [
  { key: "site_web", words: ["site", "web", "internet", "vitrine", "application", "app", "landing", "hébergement", "domaine"], service: "Création de site et application" },
  { key: "ecommerce", words: ["e-commerce", "boutique", "vendre", "commande", "panier", "catalogue"], service: "E-commerce" },
  { key: "ia", words: ["ia", "intelligence", "artificielle", "chatgpt", "chatbot", "automatiser", "automatisation", "productivité"], service: "Intelligence artificielle" },
  { key: "marketing", words: ["marketing", "publicité", "publicite", "visibilité", "visibilite", "audience", "communauté", "communaute"], service: "Réseaux sociaux et communication digitale" },
  { key: "contenus", words: ["contenu", "contenus", "post", "posts", "vidéo", "video", "story", "flyer", "affiche"], service: "Création de contenus et communication" },
  { key: "graphisme", words: ["logo", "charte", "graphique", "graphisme", "identité", "identite", "visuel", "infographie"], service: "Création graphique et identité visuelle" },
  { key: "photo", words: ["photo", "photographe", "shooting", "images"], service: "Photographe et production visuelle" },
  { key: "impression", words: ["impression", "imprimer", "t-shirt", "tshirt", "sublimation", "sérigraphie", "serigraphie", "personnalisation", "objets"], service: "Sublimation et impression personnalisée" },
  { key: "informatique", words: ["panne", "panne", "ordinateur", "pc", "dépannage", "depannage", "maintenance", "réseau", "reseau", "wifi", "logiciel"], service: "Maintenance informatique" },
  { key: "formation", words: ["formation", "apprendre", "cours", "compétence", "competence", "stage", "emploi", "recrutement", "travail", "métier", "metier"], service: "Formation et transmission" },
  { key: "entrepreneuriat", words: ["entreprendre", "entreprise", "business", "projet", "idée", "idee", "financement", "budget", "investir"], service: "Entrepreneuriat et accompagnement professionnel" },
  { key: "documents", words: ["cv", "document", "documents", "rapport", "mémoire", "memoire", "présentation", "presentation", "contrat"], service: "Documents professionnels" },
  { key: "donnees", words: ["données", "donnees", "excel", "base", "classeur", "fichiers", "gestion"], service: "Bases de données et gestion de l'information" },
  { key: "ong", words: ["ong", "association", "église", "eglise", "organisation", "coopérative", "cooperative", "fondeurope"], service: "Solutions pour ONG, associations, églises et organisations" },
  { key: "produits_numeriques", words: ["ebook", "ressource", "numérique", "numerique", "en ligne", "ligne"], service: "Produits numériques" },
];

// Mots-clés d'intention (priorité : refus > report > prix > besoin > salutation > conseil).
const RE_REFUS = /(pas intéressé|pas interesse|pas interessante|non merci|ne m'écrivez plus|n'insistez pas|arrêtez|arretez|désabonner|desabonner|\bstop\b)/i;
const RE_REPORT = /(plus tard|à plus tard|pas maintenant|je reviens(?: vers vous)?|je te recontacte|je vous recontacte|on en reparle plus tard|on reparle(?:ra)? demain|rappellez?-moi plus tard)/i;
// « Combien » seul n'est pas une intention commerciale : « combien d'habitants ? » reste une question générale.
const RE_PRIX = /(prix|tarif|coûte|coute|budget|devis|cher|chère|chere|délai|delai|combien\s+(?:coûte|coute|ça coûte|cela coûte|vous facturez|pour (?:créer|réaliser|livrer))|quel(?:le)?\s+(?:est\s+)?le\s+(?:prix|tarif|coût|cout))/i;
const RE_PRIX_EXPLICITE = /(prix|tarif|coûte|coute|devis|cher|chère|chere|délai|delai|combien\s+(?:coûte|coute|ça coûte|cela coûte|vous facturez|pour (?:créer|réaliser|livrer)))/i;
const RE_BESOIN = /(je veux(?!\s+(?:savoir|comprendre|connaître|connaitre|apprendre|demander))|je voudrais(?!\s+(?:savoir|comprendre|connaître|connaitre))|j'aimerais(?!\s+(?:savoir|comprendre|connaître|connaitre))|je cherche(?!\s+à\s+(?:comprendre|savoir|apprendre))|j'ai besoin|besoin de|proposez|proposez-moi|faire pour moi|vous pouvez (?:créer|faire))/i;
const RE_SALUT = /^(bonjour|bonsoir|salut|hello|hi|coucou|bjr|slt|bonne (journée|journee|soirée|soiree))\b/i;
const RE_CONSEIL = /(conseil|astuce|aide|comment|pourquoi|quel(le)?|est-ce que|peux-tu|pouvez-vous|m'expliquer|explique)/i;

export function norm(s) {
  return String(s ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function hasWord(t, w) {
  const wn = norm(w);
  return new RegExp(`\\b${wn.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(t);
}

export function detectTopic(text) {
  const t = norm(text);
  for (const topic of TOPICS) {
    for (const w of topic.words) {
      if (hasWord(t, w)) return topic;
    }
  }
  return null;
}

/**
 * Classe un message entrant : { intent, topic, service }.
 * Intents : refus | report | prix_delai | besoin_service | salutation | conseil | question_generale.
 * Aucun appel réseau : 100 % local et gratuit.
 */
export function classifyMessage(text) {
  const t = String(text ?? "");
  if (RE_REFUS.test(t)) return { intent: "refus", topic: null, service: null };
  if (RE_REPORT.test(t)) return { intent: "report", topic: null, service: null };
  const topic = detectTopic(t);
  const demandeTarif = RE_PRIX.test(t) && (RE_PRIX_EXPLICITE.test(t) || (topic && topic.key !== "entrepreneuriat"));
  if (demandeTarif && (topic || /vos services|votre prestation|rising digital|notre offre/i.test(t)))
    return { intent: "prix_delai", topic: topic?.key ?? null, service: topic?.service ?? null };
  if (RE_SALUT.test(t)) return { intent: "salutation", topic: topic?.key ?? null, service: topic?.service ?? null };
  // Une demande d'explication reste un conseil même si elle mentionne un sujet du catalogue.
  if (RE_CONSEIL.test(t) && !RE_BESOIN.test(t)) return { intent: "conseil", topic: topic?.key ?? null, service: topic?.service ?? null };
  if (RE_BESOIN.test(t)) return { intent: "besoin_service", topic: topic?.key ?? null, service: topic?.service ?? null };
  return { intent: "question_generale", topic: topic?.key ?? null, service: topic?.service ?? null };
}

// Repères de prix OFFICIELS du site (page d'accueil) — indicatifs, jamais présentés comme définitifs.
const PRICE_ANCHORS = `Repères officiels du site (à citer uniquement comme "repères indicatifs", jamais comme devis) :
- "Présence professionnelle" (identité visuelle ou site vitrine) : 25 000 à 350 000 F CFA ;
- "IA & productivité" (diagnostic, automatisation ciblée, prise en main) : 75 000 à 250 000 F CFA ;
- "Communication & outils" (contenus, e-commerce, accompagnement) : sur devis.
Le devis final dépend du contenu, de la personnalisation et du délai — toujours le préciser.`;

const STRATEGIES = {
  salutation: `Accueille naturellement, brièvement. Présente Rising Digital Solutions en une phrase seulement si cela aide à situer l'échange. Ne transforme pas une simple salutation en questionnaire : invite simplement la personne à dire ce qu'elle souhaite, avec ses propres mots.`,
  prix_delai: `Réponds directement à la question de prix ou de délai avec les seules informations officielles disponibles. Les repères tarifaires ci-dessous sont indicatifs, pas des devis. Si le prix exact dépend du besoin, explique pourquoi puis pose UNE seule question utile pour préciser la demande. Ne prétends pas qu'une équipe a été contactée si aucun transfert réel n'a été déclenché.`,
  besoin_service: `Montre que tu as compris le besoin, puis donne un conseil concret ou une première piste utile. Si un service réel du catalogue correspond clairement, tu peux le mentionner naturellement, sans pression. Pose une seule question de précision uniquement si elle est nécessaire pour avancer. Ne promets pas qu'une équipe préparera un devis si aucun transfert réel n'a été déclenché.`,
  conseil: `Réponds d'abord à la question, avec une explication claire, pratique et suffisamment développée. Donne des étapes, un exemple ou une mise en garde quand cela aide. Ne force aucun lien commercial. Si une information manque, précise ce qui est incertain au lieu d'inventer.`,
  question_generale: `Traite cette demande comme une vraie conversation générale. Réponds directement, même si le sujet n'a aucun rapport avec le numérique ou les services de Rising Digital Solutions. Explique, raisonne, compare ou donne des étapes selon la question. Ne fais aucune promotion et ne propose aucun service si cela n'apporte pas une aide réelle.`,
  report: `Respecte le rythme de la personne. Confirme simplement qu'elle pourra reprendre la discussion quand elle le souhaitera. Aucune pression ni relance commerciale insistante.`,
  refus: `Remercie avec respect. Confirme qu'aucune relance commerciale ne sera envoyée. N'essaie pas de convaincre la personne de changer d'avis.`,
};

/**
 * Prompt système : conseiller conversationnel d'abord, conseiller commercial seulement si pertinent.
 * Le classement local sert de contexte, jamais de formulaire ni de limite aux sujets possibles.
 */
export function buildSystemPrompt({ brand, services = [], classification = {}, siteUrl, phone, contactProfile = null, briefing = null, voice = false } = {}) {
  const c = classification;
  const catalogue = services.length ? `CATALOGUE RÉEL (ne cite que ces services) : ${services.join(" ; ")}.` : "";
  const serviceHint = c.service && ["prix_delai", "besoin_service"].includes(c.intent)
    ? `Un service du catalogue semble éventuellement lié : « ${c.service} ». Ne le mentionne que si cela aide réellement à répondre.`
    : "";
  const prices = c.intent === "prix_delai" ? PRICE_ANCHORS : "";
  return `Tu es RISING DIGITAL AGENT, le conseiller numérique et assistant conversationnel de RISING DIGITAL SOLUTIONS, basé à Agbelouvé au Togo.

TA MISSION : discuter avec chaque personne comme un conseiller compétent, attentif, naturel et fiable — jamais comme un formulaire automatisé, un télévendeur ou un robot de qualification. La personne peut te parler de numérique, d'entrepreneuriat, d'études, de travail, de vie pratique, de culture, de sciences, de technologie ou de tout autre sujet. Tu dois essayer de l'aider sur le sujet réellement posé, même s'il n'a aucun rapport avec l'entreprise.

RÈGLES DE CONVERSATION :
- Réponds d'abord à la demande réelle. Ne remplace pas une réponse par une question de qualification.
- Comprends le contexte et les messages précédents. Ne recommence pas l'entretien à chaque message et ne repose pas une question déjà répondue.
- Adapte la longueur à la demande : une salutation appelle une réponse courte ; une question complexe mérite une explication structurée, des exemples et des étapes. La longueur doit simplement être adaptée à la question.
- Pose au maximum une question à la fois, seulement lorsqu'une précision est vraiment nécessaire. Tu peux aussi répondre sans poser de question.
- Parle naturellement dans la langue utilisée par la personne. En français, utilise un français clair, chaleureux et accessible. Évite les formulations mécaniques et les répétitions.
- Ne propose un service de RISING DIGITAL SOLUTIONS que si ce service répond réellement au besoin exprimé. Une question générale n'est pas une occasion obligatoire de vendre. Ne cherche jamais à convertir « à tout prix ».
- Ne prétends jamais avoir contacté, alerté ou transmis une demande à un humain si le système n'a pas réellement effectué ce transfert. Si la personne demande explicitement un humain, applique le mécanisme de transfert prévu.

FIABILITÉ :
- N'invente aucun fait, chiffre, tarif, délai, témoignage, source, actualité ou capacité de l'entreprise.
- Si une information est incertaine, dis-le clairement et distingue les faits des estimations ou conseils.
- Tu n'as pas automatiquement accès à Internet en temps réel. Ne prétends pas avoir vérifié une actualité ou une donnée récente si aucune recherche réelle n'a été effectuée. Pour une question qui dépend d'informations récentes, explique cette limite et indique ce qu'il faudrait vérifier.
- Pour les sujets médicaux, juridiques, financiers ou de sécurité, donne des informations générales prudentes, signale les limites et recommande un professionnel lorsque la situation le justifie.
- Ne demande jamais de mot de passe, code secret, code OTP ou donnée bancaire sensible.

${STRATEGIES[c.intent] || STRATEGIES.question_generale}

${contactProfile
    ? `CONTEXTE MÉMORISÉ DE CET INTERLOCUTEUR : sujets abordés : ${(contactProfile.sujets || []).join(", ") || "aucun"}${contactProfile.dernier_besoin ? ` ; dernier besoin exprimé : « ${contactProfile.dernier_besoin} »` : ""}. Utilise ce contexte avec discrétion pour assurer la continuité, sans enfermer la personne dans son ancien besoin.`
    : `Aucun profil antérieur fiable n'est disponible. Découvre le contexte progressivement au fil de la conversation ; ne lance pas un questionnaire.`}
${voice ? `MESSAGE VOCAL TRANSCRIT : la transcription peut contenir des erreurs. Si un passage est réellement ambigu, demande de répéter uniquement ce passage ; ne devine pas le contenu manquant.` : ""}
${briefing ? `CONTEXTE DU JOUR DISPONIBLE (peut aider si pertinent, mais ne garantit pas une actualité exhaustive) :\n${briefing}` : ""}
${serviceHint}
${catalogue}
${prices}

Site officiel : ${siteUrl || SITE_DEFAULT}${phone ? ` ; contact de l'équipe : ${phone}` : ""}.

IDENTITÉ ET POSITIONNEMENT DE LA MARQUE :
${brand || "Rising Digital Solutions : solutions numériques, intelligence artificielle, création visuelle, communication, formation et accompagnement."}`;
}

/**
 * Décide si l'on répond à un message entrant.
 * Règle héritée : le délai anti-spam (wa_cooldown_hours) s'applique aux messages sans enjeu.
 * Amélioration : une vraie question ou un besoin obtient une réponse dès que l'écart minimal
 * (20 min par défaut) est respecté — on n'ignore plus un client pendant 6 heures.
 */
export function shouldReply({ lastOutTs, cooldownH = 0, intent = "question_generale", hasNeed = false, minGapMin = 3, now = Date.now() } = {}) {
  if (!lastOutTs) return true;
  const gapH = (now - lastOutTs) / 3600_000;
  const gapMin = (now - lastOutTs) / 60_000;
  const engages = hasNeed || ["prix_delai", "besoin_service", "conseil", "question_generale", "report", "refus", "salutation"].includes(intent);
  if (!engages) return gapH >= cooldownH;           // bavardage/bruit : ancien comportement conservé
  // BUG v4.2 corrigé : l'ancienne condition "gapH < 24" rendait le bot MUET pour tout
  // client qui revenait plus de 24h après le dernier message du bot — c'était la panne
  // constatée. Désormais une vraie question a TOUJOURS une réponse ; seul l'écart minimal
  // (3 min) protège des boucles de messages instantanées.
  return gapMin >= minGapMin;
}

/**
 * Délai (heures) avant relance, ou null si aucune relance ne se justifie.
 * Les délais restent dans la fenêtre de 24 h de WhatsApp Cloud API (réponse libre interdite au-delà,
 * sauf modèle de message approuvé par Meta — voir processDueFollowups).
 */
export function nextFollowupDelayH(intent, hasNeed = false) {
  if (intent === "refus") return null;      // jamais de relance après un refus
  if (intent === "report") return 20;       // "je reviens demain" -> relance le lendemain, dans la fenêtre
  if (intent === "prix_delai") return 5;    // devis annoncé, réponse en attente
  if (intent === "besoin_service" || hasNeed) return 4;
  // Une question générale ou un conseil ne déclenche jamais une relance commerciale.
  return null;                              // échange informatif sans intention d'achat : pas de relance
}

// ---- Contrôle de sortie : protection renforcée sur les réponses commerciales ----

// Repères tarifaires officiels autorisés pour les demandes commerciales.
const PRICE_ALLOWED = new Set(["25000", "350000", "75000", "250000"]);

/**
 * Valide la réponse avant envoi. Le contrôle des montants et des promesses est
 * volontairement réservé aux demandes commerciales ; les liens HTTPS utiles et
 * les montants des réponses générales ne sont pas bloqués.
 */
export function sanitizeReply(text, { strictPrices = false } = {}) {
  const t = String(text ?? "").trim();
  if (!t || t.length > 3500) return false;
  // Refuse les protocoles exécutables, mais ne bloque pas les liens HTTPS utiles
  // ni les montants ordinaires dans une réponse de culture générale.
  if (/(?:javascript|data|vbscript):/i.test(t)) return false;
  if (strictPrices) {
    if (/garanti|garantie de résultat|satisfait ou rembours/i.test(t)) return false;
    const prices = t.match(/\d[\d\s.,·']*\s*(?:f\s?cfa|cfa|€|eur(?:os?)?|\$|usd|dollars?|francs?)/gi) || [];
    for (const p of prices) {
      if (!PRICE_ALLOWED.has(p.replace(/\D/g, ""))) return false;
    }
  }
  return true;
}

// ---- v4.2 : relances jamais la nuit (Lomé = UTC, donc 22h-7h locales = UTC) ----

/**
 * Ajuste une échéance ISO : entre 22h et 7h, la repousse au prochain 09h00.
 * Une relance à 2h du matin tue la conversion et paraît suspecte.
 */
export function adjustToDaytime(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const h = d.getUTCHours();
  if (h < 7) return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 9, 0, 0)).toISOString();
  if (h >= 22) return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 9, 0, 0)).toISOString();
  return iso;
}

// ---- v4.2 : mémoire par contact (profil persistant, gratuit, table memory existante) ----

export async function loadContactProfile(env, tenantId, contactId) {
  try {
    const raw = await getMemory(env, tenantId, `contact:${contactId}`, "profil");
    return raw ? JSON.parse(raw) : null;
  } catch { return null; } // mémoire indisponible : le reste du flux continue
}

export async function saveContactProfile(env, tenantId, contactId, profile) {
  await setMemory(env, tenantId, `contact:${contactId}`, "profil", JSON.stringify(profile));
}

/** Fusion pure (testable) : sujets déjà abordés (5 max), dernier service, dernier besoin. */
export function mergeProfile(existing, classification, need = null) {
  const p = existing && typeof existing === "object" ? existing : {};
  const sujets = new Set([...(Array.isArray(p.sujets) ? p.sujets : [])]);
  if (classification?.topic) sujets.add(classification.topic);
  if (classification?.service) sujets.add(classification.service);
  return {
    sujets: [...sujets].slice(-5),
    dernier_service: classification?.service || p.dernier_service || null,
    dernier_besoin: need || p.dernier_besoin || null,
    maj: nowISO(),
  };
}

// ---- v4.3 : FAQ auto-apprenante (réponse instantanée aux questions récurrentes) ----
// Chaque question posée 3+ fois stocke sa meilleure réponse ; les suivantes partent
// sans appel IA (économie de quota, cohérence). Clé = 4 mots significatifs principaux.

import { normWords, jaccard } from "../core/util.js";

export function faqKey(text) {
  return [...normWords(text)].sort().slice(0, 4).join("-").slice(0, 80) || "divers";
}

/** Vrai si deux questions sont les mêmes au sens pratique (similarité > 0.6). */
export function sameQuestion(a, b) {
  return a.length > 8 && b.length > 8 && jaccard(a, b) > 0.6;
}

export async function lookupFaq(env, tenantId, text) {
  const rows = (await env.DB.prepare("SELECT key, value FROM memory WHERE tenant_id=? AND scope='faq'").bind(tenantId).all()).results || [];
  for (const r of rows) {
    let entry;
    try { entry = JSON.parse(r.value); } catch { continue; }
    if (entry?.count >= 3 && entry?.answer && (r.key === faqKey(text) || sameQuestion(entry.question, text))) return entry.answer;
  }
  return null;
}

/** Enregistre/renforce une question-réponse. Jamais bloquant : échec = silencieux. */
export async function rememberFaq(env, tenantId, text, answer) {
  const key = faqKey(text);
  const ex = await env.DB.prepare("SELECT value FROM memory WHERE tenant_id=? AND scope='faq' AND key=?").bind(tenantId, key).first();
  let entry = { question: String(text).slice(0, 200), answer: String(answer).slice(0, 500), count: 0 };
  if (ex?.value) { try { entry = { ...entry, ...JSON.parse(ex.value) }; } catch { /* repartir à neuf */ } }
  entry.count = Number(entry.count || 0) + 1;
  await setMemory(env, tenantId, "faq", key, JSON.stringify(entry));
}

// ---- v4.3 : hashtag + affiche du service pour Facebook (publiés AVEC le post) ----

export function hashtagsForService(serviceTitle) {
  const base = ["#RisingDigital", "#Togo", "#Numérique", "#Entrepreneuriat"];
  const mots = normWords(serviceTitle);
  const map = {
    "creation": ["#Création"], "site": ["#SiteWeb"], "application": ["#Application"],
    "intelligence": ["#IA"], "artificielle": ["#IA"], "commerce": ["#Ecommerce"],
    "graphique": ["#Graphisme"], "identite": ["#IdentitéVisuelle"], "formation": ["#Formation"],
    "maintenance": ["#Maintenance"], "impression": ["#Impression"], "reseaux": ["#RéseauxSociaux"],
    "communication": ["#Communication"], "marketing": ["#Marketing"], "photographe": ["#Photographie"],
    "donnees": ["#Données"], "documents": ["#Documents"], "entrepreneuriat": ["#Entrepreneuriat"],
  };
  const extra = new Set();
  for (const w of mots) for (const tag of map[w] || []) extra.add(tag);
  return [...extra, ...base].slice(0, 6).join(" ");
}

// ---- Persistance des relances (table followups, migration 0003) ----

export async function cancelScheduledFollowups(env, conversationId) {
  await env.DB.prepare("UPDATE followups SET status='cancelled', updated_at=? WHERE conversation_id=? AND status='scheduled'")
    .bind(nowISO(), conversationId).run();
}

export async function scheduleFollowup(env, { tenantId, contactId, conversationId, angle = null, dueAt }) {
  const ex = await env.DB.prepare("SELECT id FROM followups WHERE conversation_id=? AND status='scheduled'").bind(conversationId).first();
  if (ex) return ex.id;
  const r = await env.DB.prepare("INSERT INTO followups(tenant_id,contact_id,conversation_id,angle,due_at,created_at) VALUES(?,?,?,?,?,?)")
    .bind(tenantId, contactId, conversationId, angle, adjustToDaytime(dueAt), nowISO()).run();
  return r.meta.last_row_id;
}

function relanceTemplate({ service = null, need = null } = {}) {
  const sujet = service ? ` au sujet de « ${service} »` : need ? ` au sujet de votre projet` : "";
  return `Bonjour 👋 C'est l'assistant de Rising Digital Solutions. Vous vous renseigniez${sujet} il y a quelque temps — si le sujet est toujours d'actualité, je peux transmettre votre demande à l'équipe pour une proposition et un devis expliqué, sans engagement. Le catalogue reste visible ici : ${SITE_DEFAULT}`;
}

function buildRelancePrompt({ need = null, service = null, hoursIdle = 0 } = {}) {
  return `Tu relances une conversation WhatsApp pour Rising Digital Solutions (Agbelouvé, Togo). La personne s'était renseignée${service ? ` au sujet de « ${service} »` : ""} il y a environ ${Math.round(hoursIdle)} heures, puis n'a plus répondu.
${need ? `Son besoin exprimé : « ${need.slice(0, 300)} ».` : ""}
Écris UN message de relance en français : court (60 mots max), chaleureux, PAS insistant, qui fait référence à son besoin (sans le répéter mot pour mot), apporte une micro-valeur (une précision utile sur le service ou la méthode), et se termine par UNE question simple sur la suite (toujours intéressé(e) ? bon moment pour une proposition ?).
Honnêteté absolue : aucun prix, délai ou engagement inventé. Réponds uniquement avec le message.`;
}

/**
 * Exécute les relances arrivées à échéance (appelé par le cron des 15 minutes).
 * Garde-fous : conversation sans handoff, prospect non gagné/perdu, fenêtre Meta de 24 h
 * respectée (au-delà, la relance est marquée 'template_required' — elle exige un modèle
 * de message approuvé, jamais un envoi libre). Aucun faux succès.
 */
export async function processDueFollowups(env, limit = 10) {
  const now = nowISO();
  const due = (await env.DB.prepare(
    `SELECT f.id, f.tenant_id, f.contact_id, f.conversation_id, f.angle, f.attempts
     FROM followups f JOIN conversations c ON c.id = f.conversation_id
     WHERE f.status='scheduled' AND f.due_at<=? AND c.handoff=0 ORDER BY f.due_at LIMIT ?`
  ).bind(now, Math.max(1, Math.min(50, Number(limit) || 10))).all()).results || [];
  const { send } = await import("./whatsapp.js");
  const result = { sent: 0, deferred: 0, templateRequired: 0, cancelled: 0, failed: 0 };
  for (const f of due) {
    const claim = await env.DB.prepare("UPDATE followups SET attempts=attempts+1, updated_at=? WHERE id=? AND status='scheduled'")
      .bind(nowISO(), f.id).run();
    if (!(claim.meta?.changes > 0)) continue;
    try {
      const lead = await env.DB.prepare("SELECT service, need, status FROM leads WHERE tenant_id=? AND contact_id=? ORDER BY id DESC LIMIT 1")
        .bind(f.tenant_id, f.contact_id).first();
      if (lead && ["gagné", "perdu"].includes(lead.status)) {
        await env.DB.prepare("UPDATE followups SET status='cancelled', updated_at=? WHERE id=?").bind(nowISO(), f.id).run();
        result.cancelled++;
        continue;
      }
      const lastIn = await env.DB.prepare("SELECT ts FROM messages WHERE conversation_id=? AND direction='in' ORDER BY id DESC LIMIT 1")
        .bind(f.conversation_id).first();
      const idleMs = lastIn?.ts ? Date.now() - new Date(lastIn.ts).getTime() : Infinity;
      if (idleMs > 24 * 3600_000) {
        // Fenêtre de service client Meta dépassée : un envoi libre serait refusé — on l'assume.
        await env.DB.prepare("UPDATE followups SET status='template_required', updated_at=? WHERE id=?").bind(nowISO(), f.id).run();
        await log(env, "info", "relance_fenetre_24h", `followup #${f.id} hors fenêtre 24h : modèle Meta requis pour relancer`, f.tenant_id);
        result.templateRequired++;
        continue;
      }
      const text = await composeRelance(env, f, lead, idleMs);
      const response = await send(env, (await env.DB.prepare("SELECT external_id FROM contacts WHERE id=? AND tenant_id=?").bind(f.contact_id, f.tenant_id).first()).external_id, text);
      const externalId = response?.messages?.[0]?.id;
      if (typeof externalId !== "string" || !externalId) throw new Error("relance sans identifiant WhatsApp");
      await env.DB.batch([
        env.DB.prepare("INSERT OR IGNORE INTO messages(tenant_id,conversation_id,direction,external_id,body,ts) VALUES(?,?,?,?,?,?)")
          .bind(f.tenant_id, f.conversation_id, "out", externalId, text, nowISO()),
        env.DB.prepare("UPDATE followups SET status='sent', sent_at=?, updated_at=? WHERE id=?").bind(nowISO(), nowISO(), f.id),
      ]);
      await log(env, "info", "relance_envoyee", `followup #${f.id} → contact #${f.contact_id}`, f.tenant_id);
      result.sent++;
    } catch (e) {
      const attempts = Number(f.attempts) || 1;
      if (attempts >= 3) {
        await env.DB.prepare("UPDATE followups SET status='failed', updated_at=? WHERE id=?").bind(nowISO(), f.id).run();
        result.failed++;
      } else {
        await env.DB.prepare("UPDATE followups SET status='scheduled', due_at=?, updated_at=? WHERE id=?")
          .bind(adjustToDaytime(new Date(Date.now() + 2 * 3600_000).toISOString()), nowISO(), f.id).run();
        result.deferred++;
      }
      await log(env, "warn", "relance_echec", String(e?.message ?? e).slice(0, 300), f.tenant_id).catch(() => {});
    }
  }
  return result;
}

async function composeRelance(env, f, lead, idleMs) {
  const history = (await env.DB.prepare("SELECT direction, body FROM messages WHERE conversation_id=? ORDER BY id DESC LIMIT 4")
    .bind(f.conversation_id).all()).results.reverse();
  const msgs = [
    { role: "system", content: buildRelancePrompt({ need: lead?.need, service: lead?.service || f.angle, hoursIdle: idleMs / 3600_000 }) },
    ...history.map(h => ({ role: h.direction === "in" ? "user" : "assistant", content: h.body })),
  ];
  const ai = await runAI(env, "chat_reply", { messages: msgs, max_tokens: 200 });
  if (ai.ok) return ai.text.slice(0, 800);
  return relanceTemplate({ service: lead?.service || f.angle, need: lead?.need }); // repli honnête, sans IA
}
