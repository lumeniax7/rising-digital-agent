// Moteur de conversation v4.1 — diversification des sujets, conversion en client, relances.
// Principes : (1) le classement du message est local et gratuit (aucun appel IA supplémentaire) ;
// (2) honnêteté absolue — jamais de prix, délai ou information inventés, "je ne sais pas" autorisé ;
// (3) l'existant (webhook, CRM, handoff humain, anti-spam, quotas IA) reste inchangé : on s'y branche.

import { nowISO } from "../core/util.js";
import { log } from "../core/log.js";
import { runAI } from "../ai/router.js";

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
const RE_REPORT = /(plus tard|à plus tard|je reviens|reviens vers|demain|la semaine prochaine|le mois prochain|pas maintenant|je te recontacte|je vous recontacte|l'année prochaine)/i;
const RE_PRIX = /(prix|combien|tarif|coûte|coute|budget|devis|cher|chère|chere|délai|delai|combien de temps)/i;
const RE_BESOIN = /(je veux|je voudrais|j'aimerais|je cherche|j'ai besoin|besoin de|proposez|proposez-moi|faire pour moi|vous pouvez (créer|faire|faire))/i;
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
  if (RE_PRIX.test(t)) return { intent: "prix_delai", topic: topic?.key ?? null, service: topic?.service ?? null };
  if (RE_SALUT.test(t)) return { intent: "salutation", topic: topic?.key ?? null, service: topic?.service ?? null };
  // Une demande d'explication reste un conseil même si elle mentionne un sujet du catalogue.
  if (RE_CONSEIL.test(t) && !RE_BESOIN.test(t)) return { intent: "conseil", topic: topic?.key ?? null, service: topic?.service ?? null };
  if (RE_BESOIN.test(t) || (topic && t.length > 15)) return { intent: "besoin_service", topic: topic?.key ?? null, service: topic?.service ?? null };
  return { intent: "question_generale", topic: topic?.key ?? null, service: topic?.service ?? null };
}

// Repères de prix OFFICIELS du site (page d'accueil) — indicatifs, jamais présentés comme définitifs.
const PRICE_ANCHORS = `Repères officiels du site (à citer uniquement comme "repères indicatifs", jamais comme devis) :
- "Présence professionnelle" (identité visuelle ou site vitrine) : 25 000 à 350 000 F CFA ;
- "IA & productivité" (diagnostic, automatisation ciblée, prise en main) : 75 000 à 250 000 F CFA ;
- "Communication & outils" (contenus, e-commerce, accompagnement) : sur devis.
Le devis final dépend du contenu, de la personnalisation et du délai — toujours le préciser.`;

const STRATEGIES = {
  salutation: `Souhaite la bienvenue chaleureusement, présente Rising Digital Solutions en UNE phrase (studio numérique à Agbelouvé, Togo), puis pose UNE question ouverte sur l'activité ou le projet de la personne pour découvrir son besoin réel.`,
  prix_delai: `La personne demande un prix ou un délai : cite uniquement les repères officiels ci-dessous (en précisant qu'ils sont indicatifs), n'invente JAMAIS un chiffre absent de cette page, puis propose de faire préparer un devis expliqué par l'équipe : demande l'activité, l'objectif et le délai souhaité.`,
  besoin_service: `Un besoin est identifié : reformule-le en une phrase pour montrer que tu as compris, cite le service du catalogue correspondant, pose UNE question de cadrage (objectif, public ou délai), puis annonce que l'équipe préparera une proposition et un devis expliqué. Oriente vers le site pour voir les réalisations.`,
  conseil: `Réponds D'ABORD utilement et honnêtement à la question posée (si tu ne sais pas, dis-le simplement — jamais d'invention), puis fais un pont naturel et non insistant vers le service du catalogue qui peut aider concrètement sur ce sujet.`,
  question_generale: `Réponds honnêtement et de façon utile, même si le sujet sort du numérique (sans inventer de fait, chiffre ou actualité : si tu n'es pas certain, dis-le). Enchaîne ensuite, avec légèreté, sur un lien possible avec un service pertinent du catalogue si le sujet s'y prête.`,
  report: `Respecte le choix de la personne sans insister : confirme gentiment que tout reste disponible sur le site et que l'équipe reste joignable quand elle voudra. Aucune pression.`,
  refus: `Remercie pour la franchise, confirme poliment qu'aucune relance ne sera envoyée, et signale simplement que le site reste accessible librement. Reste bref et bienveillant.`,
};

/**
 * Prompt système enrichi : sujet variés autorisés, objectif de conversion constant, honnêteté stricte.
 * Remplace l'ancien prompt figé sans toucher au reste du flux (handoff, CRM, anti-spam).
 */
export function buildSystemPrompt({ brand, services = [], classification = {}, siteUrl, phone } = {}) {
  const c = classification;
  const catalogue = services.length ? `Catalogue réel (ne cite que ces services, sans en inventer) : ${services.join(" ; ")}.` : "";
  const pont = c.service
    ? `Pont naturel pour cet échange : « ${c.service} » (service réel du catalogue).`
    : c.topic
      ? `Aucun service ne correspond mot pour mot : parle du besoin avec tes mots, puis propose la fiche « Services » du site.`
      : `Propose, si l'échange s'y prête, une visite du site pour découvrir le catalogue.`;
  return `Tu es l'assistant WhatsApp de Rising Digital Solutions (Agbelouvé, Togo) : studio numérique et partenaire de croissance (sites et applications, IA, identité visuelle, contenus, e-commerce, maintenance, impression, formation, accompagnement).

OBJECTIF PRINCIPAL — quel que soit le sujet de la discussion : rendre la personne plus intelligente ou plus outillée qu'avant l'échange, puis l'amener naturellement à devenir cliente d'AU MOINS UN service du site (visite du site, demande de devis, ou échange avec l'équipe). Tu peux discuter de sujets variés (questions générales, conseils, business, numérique, vie pratique) : réponds d'abord utilement, puis fais le pont vers un service pertinent sans forcer ni répéter la même formule.

HONNÊTETÉ ABSOLUE : n'invente JAMAIS un prix, un délai, un résultat chiffré, un témoignage, une actualité ou une information que tu ne connais pas. Si tu ne sais pas, dis-le et propose qu'un membre de l'équipe réponde précisément. Pas de promesse de résultat garanti.

STYLE : français, court (100 mots max), chaleureux, concret, une seule question à la fois pour qualifier le besoin (activité, objectif, délai, budget indicatif). Termine parfois (sans systématisme) par une invitation discrète : visiter le site ou laisser un message pour l'équipe.

${STRATEGIES[c.intent] || STRATEGIES.question_generale}

${pont}
${catalogue}
${PRICE_ANCHORS}
Site officiel : ${siteUrl || SITE_DEFAULT}${phone ? ` — WhatsApp de l'équipe : ${phone}.` : ""} La personne est déjà en train de parler sur ce numéro WhatsApp : propose plutôt la visite du site ou une mise en relation avec l'équipe pour un devis.

Profil de marque :
${brand || "Profil de marque non renseigné."}`;
}

/**
 * Décide si l'on répond à un message entrant.
 * Règle héritée : le délai anti-spam (wa_cooldown_hours) s'applique aux messages sans enjeu.
 * Amélioration : une vraie question ou un besoin obtient une réponse dès que l'écart minimal
 * (20 min par défaut) est respecté — on n'ignore plus un client pendant 6 heures.
 */
export function shouldReply({ lastOutTs, cooldownH = 0, intent = "question_generale", hasNeed = false, minGapMin = 20, now = Date.now() } = {}) {
  if (!lastOutTs) return true;
  const gapH = (now - lastOutTs) / 3600_000;
  const gapMin = (now - lastOutTs) / 60_000;
  const engages = hasNeed || ["prix_delai", "besoin_service", "conseil", "question_generale", "report", "refus", "salutation"].includes(intent);
  if (!engages) return gapH >= cooldownH;           // bavardage/bruit : ancien comportement conservé
  return gapMin >= minGapMin && gapH < 24;          // question réelle : réponse rapide, boucle bloquée
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
  if (intent === "conseil" || intent === "question_generale") return 6;
  return null;                              // simple salutation sans suite : pas de relance
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
    .bind(tenantId, contactId, conversationId, angle, dueAt, nowISO()).run();
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
          .bind(new Date(Date.now() + 2 * 3600_000).toISOString(), nowISO(), f.id).run();
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
