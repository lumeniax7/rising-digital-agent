// WhatsApp : réception durable, signature obligatoire et traitement asynchrone réessayable.
import { graph } from "./meta.js";
import { sendApprovedWhatsAppTemplate } from "./whatsapp-templates.js";
import { safeEq, redact } from "../core/util.js";
import { hmacHex } from "../core/crypto.js";
import { log } from "../core/log.js";
import { runAI } from "../ai/router.js";
import { upsertContact, upsertLead, detectLeadSignal } from "../crm/crm.js";
import { brandProfile } from "../memory/memory.js";
import { assertWhatsAppRecipientAllowed, isWhatsAppRecipientBlocked, normalizeWhatsAppRecipient } from "./whatsapp-recipient-policy.js";

const HANDOFF = /(litige|remboursement|plainte|réclamation|parler à (un|une) (humain|personne|agent|conseiller)|responsable|contrat|paiement direct|un agent|une personne réelle)/i;
const OPT_OUT = /(?:^\s*(?:stop|arr[êe]t|unsubscribe|désinscription)\b|\bdésinscris(?:-moi)?\b|\bdésinscrire\b|\bne\s+(?:me\s+)?contact(?:e|ez)?\s+plus\b|\bne\s+m['’]envoyez\s+plus\b|^\s*plus\s+de\s+messages\s*[.!]*\s*$)/i;
const RESUME = /^\s*(reprendre|start|réactiver|reactiver)\s*[.!]*\s*$/i;
const MAX_BODY_BYTES = 256 * 1024;
const MAX_MESSAGES = 20;
const MAX_ATTEMPTS = 5;
const CLAIM_LEASE_MS = 10 * 60_000;
const CATALOGUE_URL = "https://risingdigitalsolutions.pages.dev/#catalogue";
const LEGACY_AI_FALLBACK = "Bonjour 👋 Merci d'avoir contacté Rising Digital Solutions. Décrivez-nous votre besoin en un message : un membre de l'équipe vous répondra personnellement très vite.";
const AI_FAILURE_NOTICE = "J’ai bien reçu votre message. Mon assistance automatique est momentanément indisponible et je préfère ne pas vous répondre au hasard. Un membre de l’équipe pourra reprendre votre demande.";

function cleanSecret(value) {
  if (typeof value !== "string" || /[\u0000-\u001f\u007f]/.test(value)) return null;
  const trimmed = value.trim();
  return trimmed && !/\s/.test(trimmed) ? trimmed : null;
}

function constantTimeSignatureEqual(expected, actual) {
  // Comparaison sur une taille fixe ; une longueur/forme incorrecte ne court-circuite pas le HMAC.
  actual = String(actual ?? "");
  const n = 71; // "sha256=" + 64 caractères hexadécimaux
  let diff = expected.length ^ actual.length;
  for (let i = 0; i < n; i++) diff |= (expected.charCodeAt(i) || 0) ^ (actual.charCodeAt(i) || 0);
  return diff === 0;
}

async function readBoundedBody(req) {
  const length = req.headers.get("content-length");
  if (length && /^\d+$/.test(length) && Number(length) > MAX_BODY_BYTES) return { tooLarge: true };
  if (!req.body) return { text: "" };
  const reader = req.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        return { tooLarge: true };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) }; }
  catch { return { invalidEncoding: true }; }
}

function extractMessages(data) {
  if (data.entry === undefined) return [];
  if (!Array.isArray(data.entry)) throw new Error("shape");
  const messages = [];
  for (const entry of data.entry) {
    if (!entry || !Array.isArray(entry.changes)) throw new Error("shape");
    for (const change of entry.changes) {
      if (!change || !change.value || typeof change.value !== "object") throw new Error("shape");
      const list = change.value.messages ?? [];
      if (!Array.isArray(list)) throw new Error("shape");
      const profileByNumber = new Map((Array.isArray(change.value.contacts) ? change.value.contacts : [])
        .filter(contact => typeof contact?.wa_id === "string" && typeof contact?.profile?.name === "string")
        .map(contact => [contact.wa_id, contact.profile.name.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 100)]));
      for (const message of list) {
        if (messages.length >= MAX_MESSAGES) throw new Error("limit");
        if (!message || typeof message !== "object" || typeof message.id !== "string" ||
            !/^wamid\.[A-Za-z0-9._=-]{1,500}$/.test(message.id) ||
            typeof message.from !== "string" || !/^\d{5,20}$/.test(message.from)) throw new Error("message");
        const profileName = profileByNumber.get(message.from);
        messages.push(profileName ? { ...message, _profile_name: profileName } : message);
      }
    }
  }
  return messages;
}

export async function handleWhatsApp(req, env, ctx) {
  const url = new URL(req.url);
  if (req.method === "GET") {
    const verify = cleanSecret(env.WA_VERIFY);
    if (!verify) return new Response("WhatsApp non configuré", { status: 503 });
    return url.searchParams.get("hub.mode") === "subscribe" && safeEq(url.searchParams.get("hub.verify_token") || "", verify)
      ? new Response(url.searchParams.get("hub.challenge") || "", { headers: { "content-type": "text/plain" } })
      : new Response("refusé", { status: 403 });
  }
  if (req.method !== "POST") return new Response("méthode refusée", { status: 405 });

  const appSecret = cleanSecret(env.WA_APP_SECRET);
  if (!appSecret) return new Response("Webhook WhatsApp non configuré", { status: 503 });
  const body = await readBoundedBody(req);
  if (body.tooLarge) return new Response("trop volumineux", { status: 413 });
  if (body.invalidEncoding) return new Response("encodage invalide", { status: 400 });

  const signature = req.headers.get("x-hub-signature-256") || "";
  const expected = `sha256=${await hmacHex(appSecret, body.text)}`;
  if (!constantTimeSignatureEqual(expected, signature) || !/^sha256=[a-fA-F0-9]{64}$/.test(signature)) {
    await log(env, "warn", signature ? "wa_signature_invalide" : "wa_signature_absente");
    return new Response("signature invalide", { status: 401 });
  }

  let data;
  try { data = JSON.parse(body.text); }
  catch { return new Response("JSON invalide", { status: 400 }); }
  let messages;
  try { messages = extractMessages(data); }
  catch (err) {
    return new Response(err.message === "limit" ? "trop de messages" : "webhook invalide", { status: err.message === "limit" ? 413 : 400 });
  }
  // Les webhooks de statut n'ont aucune ligne à créer ; ils sont acquittés directement.
  if (!messages.length) return new Response("ok");

  try {
    await ensureWaSchema(env);
    const tenant = await env.DB.prepare("SELECT id FROM tenants WHERE slug='rds'").first();
    if (!tenant?.id) return new Response("service indisponible", { status: 503 });
    for (const message of messages) {
      const payload = JSON.stringify(message);
      await env.DB.prepare(`INSERT OR IGNORE INTO wa_inbox
        (wamid,tenant_id,sender,payload,status,attempts,next_attempt_at,last_error,created_at)
        VALUES(?,?,?,?,'pending',0,NULL,NULL,?)`)
        .bind(message.id, tenant.id, message.from, payload, new Date().toISOString()).run();
    }
    ctx?.waitUntil?.(processPendingWhatsApp(env, messages.length).catch(err => safeLog(env, "error", "wa_file_echec", err, tenant.id)));
    return new Response("ok", { status: 200 });
  } catch (err) {
    await safeLog(env, "error", "wa_persistance_echec", err);
    return new Response("service indisponible", { status: 503 });
  }
}

async function ensureWaSchema(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS wa_inbox(
    wamid TEXT PRIMARY KEY,
    tenant_id INTEGER NOT NULL,
    sender TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','completed','failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    last_error TEXT,
    claimed_at TEXT,
    reply_external_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS wa_template_queue(
    source_wamid TEXT PRIMARY KEY, tenant_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'waiting_approval' CHECK(status IN ('waiting_approval','processing','sent','failed','skipped')),
    attempts INTEGER NOT NULL DEFAULT 0, claimed_at TEXT, last_error TEXT, external_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS wa_recipient_blocks(
    phone_normalized TEXT PRIMARY KEY, reason TEXT NOT NULL DEFAULT 'owner_request',
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS wa_automation_optouts(
    tenant_id INTEGER NOT NULL, phone_normalized TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY(tenant_id, phone_normalized)
  )`).run();
}

function safeErrorText(error, env) {
  let text = error instanceof Error ? error.message : String(error ?? "erreur inconnue");
  text = redact(text, env);
  for (const key of ["WA_TOKEN", "WA_APP_SECRET", "FB_PAGE_TOKEN", "IG_TOKEN"]) {
    const secret = cleanSecret(env?.[key]);
    if (secret) text = text.split(secret).join("[masqué]");
  }
  return text.replace(/Bearer\s+[^\s,;]+/gi, "Bearer [masqué]").slice(0, 500) || "erreur inconnue";
}

async function safeLog(env, level, type, error, tenantId = null) {
  try { await log(env, level, type, safeErrorText(error, env), tenantId); } catch { /* logs non bloquants */ }
}

/**
 * Traite un lot des messages WhatsApp échus. Peut être appelé depuis le cron.
 * Etats : pending (réessayable), processing (réclamé avec bail), completed ou failed (terminal).
 */
export async function processPendingWhatsApp(env, limit = 20) {
  await ensureWaSchema(env);
  const batchSize = Math.max(1, Math.min(100, Math.floor(Number(limit) || 20)));
  const now = new Date();
  const nowIso = now.toISOString();
  const stale = new Date(now.getTime() - CLAIM_LEASE_MS).toISOString();
  const due = await env.DB.prepare(`SELECT wamid FROM wa_inbox
    WHERE (status='pending' AND (next_attempt_at IS NULL OR next_attempt_at<=?))
       OR (status='processing' AND claimed_at<=?)
    ORDER BY created_at LIMIT ?`).bind(nowIso, stale, batchSize).all();
  const result = { claimed: 0, completed: 0, retried: 0, failed: 0 };
  for (const candidate of due.results || []) {
    const claim = await env.DB.prepare(`UPDATE wa_inbox
      SET status='processing', attempts=attempts+1, claimed_at=?, updated_at=?
      WHERE wamid=? AND ((status='pending' AND (next_attempt_at IS NULL OR next_attempt_at<=?))
        OR (status='processing' AND claimed_at<=?))`)
      .bind(nowIso, nowIso, candidate.wamid, nowIso, stale).run();
    if (!claim.meta?.changes) continue;
    result.claimed++;
    const row = await env.DB.prepare("SELECT * FROM wa_inbox WHERE wamid=?").bind(candidate.wamid).first();
    try {
      await processInboxMessage(env, row);
      result.completed++;
    } catch (error) {
      const attempts = Number(row.attempts) || 1;
      const terminal = attempts >= MAX_ATTEMPTS;
      const delay = Math.min(60_000 * 2 ** Math.max(0, attempts - 1), 6 * 3600_000);
      const next = terminal ? null : new Date(Date.now() + delay).toISOString();
      const text = safeErrorText(error, env);
      await env.DB.prepare(`UPDATE wa_inbox SET status=?, next_attempt_at=?, last_error=?, claimed_at=NULL, updated_at=? WHERE wamid=? AND status='processing'`)
        .bind(terminal ? "failed" : "pending", next, text, new Date().toISOString(), row.wamid).run();
      await safeLog(env, "error", terminal ? "wa_traitement_abandonne" : "wa_traitement_reprogramme", text, row.tenant_id);
      if (terminal) result.failed++; else result.retried++;
    }
  }
  return result;
}

function isWithinCustomerServiceWindow(message, now = Date.now()) {
  const seconds = Number(message?.timestamp);
  if (!Number.isFinite(seconds) || seconds <= 0) return false;
  const sentAt = seconds * 1000;
  if (sentAt > now + 5 * 60_000) return false;
  return now - sentAt < 24 * 3600_000;
}

async function queueExpiredTemplateReply(env, inbox, tenantId) {
  await env.DB.prepare(`INSERT OR IGNORE INTO wa_template_queue(source_wamid,tenant_id,status,attempts,created_at)
    VALUES(?,?,'waiting_approval',0,?)`).bind(inbox.wamid, tenantId, new Date().toISOString()).run();
  await markCompleted(env, inbox.wamid);
  await safeLog(env, "info", "wa_template_mis_en_attente", "fenêtre 24 h expirée; aucun envoi lancé", tenantId);
}

async function processInboxMessage(env, inbox) {
  if (!inbox) throw new Error("Entrée WhatsApp introuvable après réclamation");
  // La persistance du reply et le passage à completed sont atomiques dans D1.
  if (inbox.reply_external_id) {
    await env.DB.prepare("UPDATE wa_inbox SET status='completed',next_attempt_at=NULL,last_error=NULL,claimed_at=NULL,updated_at=? WHERE wamid=?")
      .bind(new Date().toISOString(), inbox.wamid).run();
    return;
  }
  const message = JSON.parse(inbox.payload);
  if (await isWhatsAppRecipientBlocked(env, message.from)) {
    await markCompleted(env, inbox.wamid);
    await safeLog(env, "info", "wa_destinataire_bloque", "réponse supprimée par la politique de blocage", inbox.tenant_id);
    return;
  }
  const tenantId = inbox.tenant_id;
  const text = String(message.text?.body || message.button?.text || "[message non textuel]").slice(0, 4000);
  const contactId = await upsertContact(env, tenantId, "whatsapp", message.from, message._profile_name || null);
  let conv = await env.DB.prepare("SELECT id, handoff FROM conversations WHERE tenant_id=? AND channel='whatsapp' AND contact_id=? ORDER BY id DESC LIMIT 1")
    .bind(tenantId, contactId).first();
  if (!conv) {
    const inserted = await env.DB.prepare("INSERT INTO conversations(tenant_id,channel,contact_id,last_msg_at) VALUES(?,?,?,?)")
      .bind(tenantId, "whatsapp", contactId, new Date().toISOString()).run();
    conv = { id: inserted.meta.last_row_id, handoff: 0 };
  }
  // Le message entrant peut déjà exister après une reprise : cela ne doit jamais court-circuiter le traitement.
  await env.DB.prepare("INSERT OR IGNORE INTO messages(tenant_id,conversation_id,direction,external_id,body,ts) VALUES(?,?,?,?,?,?)")
    .bind(tenantId, conv.id, "in", message.id, text, new Date(Number(message.timestamp) * 1000 || Date.now()).toISOString()).run();
  await env.DB.prepare("UPDATE conversations SET last_msg_at=?, handoff=CASE WHEN handoff=1 THEN 1 ELSE ? END WHERE id=?")
    .bind(new Date().toISOString(), conv.handoff || (HANDOFF.test(text) ? 1 : 0), conv.id).run();

  const phoneNormalized = normalizeWhatsAppRecipient(message.from);
  if (OPT_OUT.test(text)) {
    await env.DB.prepare("INSERT OR IGNORE INTO wa_automation_optouts(tenant_id,phone_normalized,created_at) VALUES(?,?,?)")
      .bind(tenantId, phoneNormalized, new Date().toISOString()).run();
  }
  const optedOut = await env.DB.prepare("SELECT 1 AS found FROM wa_automation_optouts WHERE tenant_id=? AND phone_normalized=?")
    .bind(tenantId, phoneNormalized).first();
  if (optedOut && RESUME.test(text)) {
    await env.DB.prepare("DELETE FROM wa_automation_optouts WHERE tenant_id=? AND phone_normalized=?")
      .bind(tenantId, phoneNormalized).run();
    await env.DB.prepare("UPDATE conversations SET handoff=0 WHERE id=?").bind(conv.id).run();
    const acknowledgement = "D’accord, l’assistance automatique reprend. J’ai gardé le fil de nos échanges; dites-moi comment je peux poursuivre.";
    if (!isWithinCustomerServiceWindow(message)) {
      await queueExpiredTemplateReply(env, inbox, tenantId);
      return;
    }
    const response = await send(env, message.from, acknowledgement, { automatic: true });
    await persistReply(env, inbox, tenantId, conv.id, response, acknowledgement);
    await safeLog(env, "info", "wa_automatisation_reprise_par_contact", `…${message.from.slice(-4)}`, tenantId);
    return;
  }
  if (optedOut) {
    await env.DB.prepare("UPDATE conversations SET handoff=1 WHERE id=?").bind(conv.id).run();
    await markCompleted(env, inbox.wamid);
    await safeLog(env, "info", "wa_arret_automatique_demande", "réponses automatiques suspendues à la demande du contact", tenantId);
    return;
  }

  if (Number(conv.handoff) === 1 && RESUME.test(text)) {
    await env.DB.prepare("UPDATE conversations SET handoff=0 WHERE id=?").bind(conv.id).run();
    const acknowledgement = "D’accord, l’assistance automatique reprend. J’ai gardé le fil de nos échanges; dites-moi comment je peux poursuivre.";
    if (!isWithinCustomerServiceWindow(message)) {
      await queueExpiredTemplateReply(env, inbox, tenantId);
      return;
    }
    const response = await send(env, message.from, acknowledgement, { automatic: true });
    await persistReply(env, inbox, tenantId, conv.id, response, acknowledgement);
    await safeLog(env, "info", "wa_automatisation_reprise_par_contact", `…${message.from.slice(-4)}`, tenantId);
    return;
  }

  const services = (await env.DB.prepare("SELECT title,descr FROM services WHERE tenant_id=? AND active=1 ORDER BY title").bind(tenantId).all()).results || [];
  const signal = detectLeadSignal(text, services);
  if (signal.hasNeed) {
    await upsertLead(env, tenantId, contactId, { service: signal.service, need: text.slice(0, 500), urgency: signal.urgency });
    await safeLog(env, "info", "prospect_enregistre", `contact #${contactId}`, tenantId);
  }

  if (HANDOFF.test(text)) {
    const alreadyHandedOff = Number(conv.handoff) === 1;
    await env.DB.prepare("UPDATE conversations SET handoff=1 WHERE id=?").bind(conv.id).run();
    await upsertLead(env, tenantId, contactId, { status: "à traiter par un humain" });
    if (alreadyHandedOff) {
      await markCompleted(env, inbox.wamid);
      await safeLog(env, "info", "wa_transfert_humain_en_attente", "transfert déjà actif; accusé supplémentaire supprimé", tenantId);
      return;
    }
    if (!isWithinCustomerServiceWindow(message)) {
      await queueExpiredTemplateReply(env, inbox, tenantId);
      return;
    }
    const reply = "Merci pour votre message. Ce point demande l’attention d’un membre de l’équipe; votre demande est transmise pour reprise humaine.";
    const response = await send(env, message.from, reply, { automatic: true });
    await persistReply(env, inbox, tenantId, conv.id, response, reply);
    await safeLog(env, "info", "wa_transfert_humain", `contact …${message.from.slice(-4)}`, tenantId);
    return;
  }

  if (conv.handoff) {
    await markCompleted(env, inbox.wamid);
    await safeLog(env, "info", "wa_transfert_humain_en_attente", "réponse automatique suspendue pendant le transfert humain", tenantId);
    return;
  }
  const priorNotice = await env.DB.prepare(`SELECT 1 AS found FROM messages
    WHERE conversation_id=? AND direction='out' AND body IN (?,?) LIMIT 1`)
    .bind(conv.id, LEGACY_AI_FALLBACK, AI_FAILURE_NOTICE).first();
  if (priorNotice) {
    await env.DB.prepare("UPDATE conversations SET handoff=1 WHERE id=?").bind(conv.id).run();
    await markCompleted(env, inbox.wamid);
    await safeLog(env, "info", "wa_transfert_humain_en_attente", "ancien avis de repli détecté; réponses automatiques suspendues", tenantId);
    return;
  }

  const cooldown = Number((await env.DB.prepare("SELECT v FROM meta WHERE k='wa_cooldown_hours'").first())?.v ?? 6) || 0;
  if (cooldown > 0) {
    const last = await env.DB.prepare("SELECT ts FROM messages WHERE tenant_id=? AND conversation_id=? AND direction='out' ORDER BY id DESC LIMIT 1")
      .bind(tenantId, conv.id).first();
    if (last && Date.now() - new Date(last.ts).getTime() < cooldown * 3600_000) {
      await markCompleted(env, inbox.wamid);
      await safeLog(env, "info", "wa_delai_anti_spam", `…${message.from.slice(-4)}`, tenantId);
      return;
    }
  }

  if (!isWithinCustomerServiceWindow(message)) {
    await queueExpiredTemplateReply(env, inbox, tenantId);
    return;
  }

  const brand = await brandProfile(env, tenantId);
  const serviceFacts = services.map(service => `- ${service.title} : ${String(service.descr || "").slice(0, 240)}`).join("\n");
  const history = (await env.DB.prepare("SELECT direction, body FROM messages WHERE conversation_id=? ORDER BY id DESC LIMIT 12").bind(conv.id).all()).results.reverse();
  const system = `Tu es l’assistant virtuel de Rising Digital Solutions, studio numérique basé à Agbelouvé (Togo). Tu aides le fondateur à répondre avec un ton professionnel, chaleureux, naturel et direct. Ne prétends jamais être le fondateur ou une personne humaine, et ne prétends jamais avoir fait une action qui n’est pas confirmée.

Réponds d’abord à la demande réelle. Suis le fil logique des 12 derniers échanges, ne redemande pas une information déjà donnée et ne répète pas une salutation. Sois utile, calme, précis et proportionné. Pose au plus une question ciblée si un élément nécessaire manque. Si la personne expose un besoin, résume-le brièvement, propose au plus un service pertinent du catalogue, puis partage le lien du catalogue seulement si cela aide réellement. La prospection doit rester transparente, non insistante et clairement commerciale quand elle l’est; n’utilise ni pression, ni urgence artificielle, ni tactique destinée à cacher l’intention de vente. Si la personne refuse une proposition, n’insiste pas.

Utilise uniquement les faits vérifiés ci-dessous. Les services et descriptions sont connus; les tarifs, délais, disponibilités, garanties, conditions et résultats ne le sont pas ici. N’en invente aucun. Pour les questions sensibles, engagements importants ou données absentes, explique brièvement la limite et propose une reprise humaine. Réponds en français, généralement en moins de 120 mots. Le lien exact du catalogue est ${CATALOGUE_URL}.

Profil de marque :
${brand}

Catalogue vérifié :
${serviceFacts || "Aucune offre active vérifiée; ne prétends pas connaître le catalogue."}`;
  const msgs = [{ role: "system", content: system }, ...history.map(item => ({ role: item.direction === "in" ? "user" : "assistant", content: item.body }))];
  const ai = await runAI(env, "chat_reply", { messages: msgs, max_tokens: 400 });
  if (!ai.ok || !String(ai.text || "").trim()) {
    const handoffClaim = await env.DB.prepare("UPDATE conversations SET handoff=1 WHERE id=? AND handoff=0").bind(conv.id).run();
    if (!(handoffClaim.meta?.changes > 0)) {
      await markCompleted(env, inbox.wamid);
      await safeLog(env, "warn", "wa_ia_indisponible_sans_reponse", "transfert humain déjà actif; avis supplémentaire supprimé", tenantId);
      return;
    }
    const response = await send(env, message.from, AI_FAILURE_NOTICE, { automatic: true });
    await persistReply(env, inbox, tenantId, conv.id, response, AI_FAILURE_NOTICE);
    await safeLog(env, "warn", "wa_ia_indisponible_transfert_humain", "aucune réponse générée; transfert humain requis", tenantId);
    return;
  }
  const latestHandoff = await env.DB.prepare("SELECT handoff FROM conversations WHERE id=?").bind(conv.id).first();
  if (Number(latestHandoff?.handoff) === 1) {
    await markCompleted(env, inbox.wamid);
    await safeLog(env, "info", "wa_reponse_ia_annulee", "transfert humain activé pendant la génération", tenantId);
    return;
  }
  const hasPreviousReply = history.some(item => item.direction === "out");
  const disclosure = hasPreviousReply ? "" : "Je suis l’assistant virtuel de Rising Digital Solutions. ";
  const reply = `${disclosure}${ai.text.trim()}`.slice(0, 1200);
  const response = await send(env, message.from, reply, { automatic: true });
  await persistReply(env, inbox, tenantId, conv.id, response, reply);
  await safeLog(env, "info", "wa_reponse_envoyee", `…${message.from.slice(-4)} ${ai.ok ? "via " + ai.provider : "(repli statique)"}`, tenantId);
}

async function markCompleted(env, wamid) {
  await env.DB.prepare("UPDATE wa_inbox SET status='completed',next_attempt_at=NULL,last_error=NULL,claimed_at=NULL,updated_at=? WHERE wamid=?")
    .bind(new Date().toISOString(), wamid).run();
}

async function persistReply(env, inbox, tenantId, conversationId, response, text) {
  const externalId = response?.messages?.[0]?.id;
  if (typeof externalId !== "string" || !externalId) throw new Error("WhatsApp : réponse sans identifiant");
  const timestamp = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO messages(tenant_id,conversation_id,direction,external_id,body,ts) VALUES(?,?,?,?,?,?)")
      .bind(tenantId, conversationId, "out", externalId, text, timestamp),
    env.DB.prepare("UPDATE wa_inbox SET status='completed',reply_external_id=?,next_attempt_at=NULL,last_error=NULL,claimed_at=NULL,updated_at=? WHERE wamid=? AND status='processing'")
      .bind(externalId, timestamp, inbox.wamid),
  ]);
}

export async function send(env, to, body, { automatic = false } = {}) {
  // La garde immédiate est réservée aux automatisations; l’envoi manuel reste possible.
  if (automatic) await assertWhatsAppRecipientAllowed(env, to);
  const token = cleanSecret(env.WA_TOKEN);
  if (!token) throw new Error("WhatsApp non configuré");
  const phoneId = cleanSecret(env.WA_PHONE_ID);
  if (!phoneId) throw new Error("WhatsApp non configuré");
  return graph(env, "POST", `/${phoneId}/messages`,
    { messaging_product: "whatsapp", to, type: "text", text: { body } }, token);
}
