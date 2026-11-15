// WhatsApp : canal client réel — déduplication stricte, signature HMAC, assistant IA avec repli,
// CRM (contacts + prospects), détection de transfert humain. Aucune diffusion promotionnelle non conforme.
import { graph } from "./meta.js";
import { safeEq, redact } from "../core/util.js";
import { hmacHex } from "../core/crypto.js";
import { log } from "../core/log.js";
import { runAI } from "../ai/router.js";
import { upsertContact, upsertLead, detectLeadSignal } from "../crm/crm.js";
import { brandProfile } from "../memory/memory.js";

const HANDOFF = /(litige|remboursement|plainte|réclamation|parler à (un|une) (humain|personne|agent)|responsable|contrat|paiement direct)/i;

export async function handleWhatsApp(req, env, ctx) {
  if (!(env.WA_TOKEN && env.WA_PHONE_ID && env.WA_VERIFY)) return new Response("WhatsApp non configuré", { status: 503 });
  const u = new URL(req.url);
  if (req.method === "GET")
    return u.searchParams.get("hub.mode") === "subscribe" && safeEq(u.searchParams.get("hub.verify_token") || "", env.WA_VERIFY)
      ? new Response(u.searchParams.get("hub.challenge") || "", { headers: { "content-type": "text/plain" } })
      : new Response("refusé", { status: 403 });
  if (req.method !== "POST") return new Response("méthode refusée", { status: 405 });
  const raw = await req.text();
  if (raw.length > 262144) return new Response("trop volumineux", { status: 413 });
  const sig = req.headers.get("x-hub-signature-256");
  if (env.WA_APP_SECRET) {
    if (!sig) { await log(env, "warn", "wa_signature_absente"); return new Response("signature absente", { status: 401 }); }
    const expected = "sha256=" + await hmacHex(env.WA_APP_SECRET, raw);
    if (!safeEq(expected, sig)) { await log(env, "warn", "wa_signature_invalide"); return new Response("signature invalide", { status: 401 }); }
  }
  let data; try { data = JSON.parse(raw); } catch { return new Response("JSON invalide", { status: 400 }); }
  await ensureWaSchema(env);
  const tenant = (await env.DB.prepare("SELECT id FROM tenants WHERE slug='rds'").first());
  // Tous les messages de toutes les entrées sont traités (pas seulement le premier) — dédupliqués par id.
  for (const e of data.entry || []) for (const c of e.changes || []) for (const m of c.value?.messages || [])
    if (m.id && m.from) ctx.waitUntil(processMessage(env, tenant.id, m).catch(err => log(env, "error", "wa_erreur", err.message, tenant.id)));
  return new Response("ok");
}

async function ensureWaSchema(env) {
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS wa_seen(id TEXT PRIMARY KEY, ts TEXT DEFAULT CURRENT_TIMESTAMP)").run();
}

async function processMessage(env, tenantId, m) {
  const seen = await env.DB.prepare("INSERT OR IGNORE INTO wa_seen(id) VALUES(?)").bind(m.id).run();
  if (!seen.meta.changes) return log(env, "info", "wa_doublon_ignore", m.id.slice(-8), tenantId);
  const text = m.text?.body || m.button?.text || "[message non textuel]";
  const contactId = await upsertContact(env, tenantId, "whatsapp", m.from);
  let conv = (await env.DB.prepare("SELECT id, handoff FROM conversations WHERE tenant_id=? AND channel='whatsapp' AND contact_id=? ORDER BY id DESC LIMIT 1").bind(tenantId, contactId).first());
  if (!conv) {
    const r = await env.DB.prepare("INSERT INTO conversations(tenant_id,channel,contact_id,last_msg_at) VALUES(?,?,?,?)").bind(tenantId, "whatsapp", contactId, new Date().toISOString()).run();
    conv = { id: r.meta.last_row_id, handoff: 0 };
  }
  const ins = await env.DB.prepare("INSERT OR IGNORE INTO messages(tenant_id,conversation_id,direction,external_id,body,ts) VALUES(?,?,?,?,?,?)")
    .bind(tenantId, conv.id, "in", m.id, text, new Date(Number(m.timestamp) * 1000 || Date.now()).toISOString()).run();
  if (!ins.meta.changes) return log(env, "info", "wa_message_dedouble", m.id.slice(-8), tenantId);
  await env.DB.prepare("UPDATE conversations SET last_msg_at=?, handoff=? WHERE id=?")
    .bind(new Date().toISOString(), conv.handoff || (HANDOFF.test(text) ? 1 : 0), conv.id).run();

  // CRM : signaux de besoin
  const services = (await env.DB.prepare("SELECT title FROM services WHERE tenant_id=? AND active=1").bind(tenantId).all()).results;
  const sig = detectLeadSignal(text, services);
  if (sig.hasNeed) { await upsertLead(env, tenantId, contactId, { service: sig.service, need: text.slice(0, 500), urgency: sig.urgency }); await log(env, "info", "prospect_enregistre", `contact #${contactId}`, tenantId); }

  // Transfert humain : jamais de décision sensible automatisée.
  if (HANDOFF.test(text)) {
    await env.DB.prepare("UPDATE conversations SET handoff=1 WHERE id=?").bind(conv.id).run();
    await upsertLead(env, tenantId, contactId, { status: "à traiter par un humain" });
    await send(env, m.from, "Merci pour votre message 🙏 Ce point demande l'attention d'un membre de l'équipe : il vous répondra personnellement très vite.");
    return log(env, "info", "wa_transfert_humain", `contact …${m.from.slice(-4)}`, tenantId);
  }

  // Délai anti-spam configurable (défaut 6 h) — les messages restent journalisés et CRM.
  const cooldown = Number((await env.DB.prepare("SELECT v FROM meta WHERE k='wa_cooldown_hours'").first())?.v ?? 6) || 0;
  if (cooldown > 0) {
    const last = (await env.DB.prepare("SELECT ts FROM messages WHERE tenant_id=? AND conversation_id=? AND direction='out' ORDER BY id DESC LIMIT 1").bind(tenantId, conv.id).first());
    if (last && (Date.now() - new Date(last.ts).getTime()) < cooldown * 3600_000)
      return log(env, "info", "wa_delai_anti_spam", `…${m.from.slice(-4)}`, tenantId);
  }

  const brand = await brandProfile(env, tenantId);
  const history = (await env.DB.prepare("SELECT direction, body FROM messages WHERE conversation_id=? ORDER BY id DESC LIMIT 6").bind(conv.id).all()).results.reverse();
  const sys = `Tu es l'assistant de Rising Digital Solutions (Agbelouvé, Togo), prestataire polyvalent de solutions, services, création et formation numériques (sites web, IA, graphisme, formation, maintenance, impression, e-commerce). Règles : réponds en français, court (80 mots max), chaleureux et concret ; ne promets JAMAIS de prix, de délais précis, de résultats garantis ; si la demande est complexe, sensible ou commerciale avancée, invite à parler à un membre de l'équipe ; propose la visite du site. Profil de marque :\n${brand}`;
  const msgs = [{ role: "system", content: sys }, ...history.map(h => ({ role: h.direction === "in" ? "user" : "assistant", content: h.body }))];
  const ai = await runAI(env, "chat_reply", { messages: msgs, max_tokens: 300 });
  const reply = ai.ok ? ai.text.slice(0, 1200)
    : "Bonjour 👋 Merci d'avoir contacté Rising Digital Solutions. Décrivez-nous votre besoin en un message : un membre de l'équipe vous répondra personnellement très vite.";
  const j = await send(env, m.from, reply);
  if (!j.messages?.[0]?.id) throw new Error("WhatsApp : réponse sans identifiant de message");
  await env.DB.prepare("INSERT INTO messages(tenant_id,conversation_id,direction,external_id,body,ts) VALUES(?,?,?,?,?,?)")
    .bind(tenantId, conv.id, "out", j.messages[0].id, reply, new Date().toISOString()).run();
  await log(env, "info", "wa_reponse_envoyee", `…${m.from.slice(-4)} ${ai.ok ? "via " + ai.provider : "(repli statique)"}`, tenantId);
}

export async function send(env, to, body) {
  return graph(env, "POST", `/${env.WA_PHONE_ID}/messages`,
    { messaging_product: "whatsapp", to, type: "text", text: { body } }, env.WA_TOKEN);
}
