// WhatsApp : réception durable, signature obligatoire et traitement asynchrone réessayable.
import { graph } from "./meta.js";
import { safeEq, redact } from "../core/util.js";
import { hmacHex } from "../core/crypto.js";
import { log } from "../core/log.js";
import { runAI } from "../ai/router.js";
import { upsertContact, upsertLead, detectLeadSignal } from "../crm/crm.js";
import { brandProfile } from "../memory/memory.js";

const HANDOFF = /(litige|remboursement|plainte|réclamation|parler à (un|une) (humain|personne|agent)|responsable|contrat|paiement direct)/i;
const MAX_BODY_BYTES = 256 * 1024;
const MAX_MESSAGES = 20;
const MAX_ATTEMPTS = 5;
const CLAIM_LEASE_MS = 10 * 60_000;

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
      for (const message of list) {
        if (messages.length >= MAX_MESSAGES) throw new Error("limit");
        if (!message || typeof message !== "object" || typeof message.id !== "string" ||
            !/^wamid\.[A-Za-z0-9._=-]{1,500}$/.test(message.id) ||
            typeof message.from !== "string" || !/^\d{5,20}$/.test(message.from)) throw new Error("message");
        messages.push(message);
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

async function processInboxMessage(env, inbox) {
  if (!inbox) throw new Error("Entrée WhatsApp introuvable après réclamation");
  // La persistance du reply et le passage à completed sont atomiques dans D1.
  if (inbox.reply_external_id) {
    await env.DB.prepare("UPDATE wa_inbox SET status='completed',next_attempt_at=NULL,last_error=NULL,claimed_at=NULL,updated_at=? WHERE wamid=?")
      .bind(new Date().toISOString(), inbox.wamid).run();
    return;
  }
  const message = JSON.parse(inbox.payload);
  const tenantId = inbox.tenant_id;
  const text = message.text?.body || message.button?.text || "[message non textuel]";
  const contactId = await upsertContact(env, tenantId, "whatsapp", message.from);
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
  await env.DB.prepare("UPDATE conversations SET last_msg_at=?, handoff=? WHERE id=?")
    .bind(new Date().toISOString(), conv.handoff || (HANDOFF.test(text) ? 1 : 0), conv.id).run();

  const services = (await env.DB.prepare("SELECT title FROM services WHERE tenant_id=? AND active=1").bind(tenantId).all()).results || [];
  const signal = detectLeadSignal(text, services);
  if (signal.hasNeed) {
    await upsertLead(env, tenantId, contactId, { service: signal.service, need: text.slice(0, 500), urgency: signal.urgency });
    await safeLog(env, "info", "prospect_enregistre", `contact #${contactId}`, tenantId);
  }

  if (HANDOFF.test(text)) {
    await env.DB.prepare("UPDATE conversations SET handoff=1 WHERE id=?").bind(conv.id).run();
    await upsertLead(env, tenantId, contactId, { status: "à traiter par un humain" });
    const reply = "Merci pour votre message 🙏 Ce point demande l'attention d'un membre de l'équipe : il vous répondra personnellement très vite.";
    const response = await send(env, message.from, reply);
    await persistReply(env, inbox, tenantId, conv.id, response, reply);
    await safeLog(env, "info", "wa_transfert_humain", `contact …${message.from.slice(-4)}`, tenantId);
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

  const brand = await brandProfile(env, tenantId);
  const history = (await env.DB.prepare("SELECT direction, body FROM messages WHERE conversation_id=? ORDER BY id DESC LIMIT 6").bind(conv.id).all()).results.reverse();
  const system = `Tu es l'assistant de Rising Digital Solutions (Agbelouvé, Togo), prestataire polyvalent de solutions, services, création et formation numériques (sites web, IA, graphisme, formation, maintenance, impression, e-commerce). Règles : réponds en français, court (80 mots max), chaleureux et concret ; ne promets JAMAIS de prix, de délais précis, de résultats garantis ; si la demande est complexe, sensible ou commerciale avancée, invite à parler à un membre de l'équipe ; propose la visite du site. Profil de marque :\n${brand}`;
  const msgs = [{ role: "system", content: system }, ...history.map(item => ({ role: item.direction === "in" ? "user" : "assistant", content: item.body }))];
  const ai = await runAI(env, "chat_reply", { messages: msgs, max_tokens: 300 });
  const reply = ai.ok ? ai.text.slice(0, 1200)
    : "Bonjour 👋 Merci d'avoir contacté Rising Digital Solutions. Décrivez-nous votre besoin en un message : un membre de l'équipe vous répondra personnellement très vite.";
  const response = await send(env, message.from, reply);
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

export async function send(env, to, body) {
  const token = cleanSecret(env.WA_TOKEN);
  if (!token) throw new Error("WhatsApp non configuré");
  const phoneId = cleanSecret(env.WA_PHONE_ID);
  if (!phoneId) throw new Error("WhatsApp non configuré");
  return graph(env, "POST", `/${phoneId}/messages`,
    { messaging_product: "whatsapp", to, type: "text", text: { body } }, token);
}
