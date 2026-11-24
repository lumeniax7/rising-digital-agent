// API du tableau de bord (/api/*).
// Toutes les routes métier exigent une session admin et un jeton CSRF valide.
// Miroir GitHub Pages : si ALLOWED_ORIGIN correspond à l'origine de la requête,
// CORS + cookies SameSite=None sont activés (l'API reste hébergée par le Worker).
import { json, nowISO } from "../core/util.js";
import { log } from "../core/log.js";
import { isAdminPasswordConfigured, validCsrfToken, validRequestOrigin, login, rateLimit, requireAuth, sessionCookie, logoutCookie } from "./auth.js";
import { generatePost } from "../content/generator.js";
import { publishChannel, publishDue, refreshPostStatuses } from "../social/publish.js";
import { channelsEnabled, missingConfig, getMode } from "../core/config.js";
import { ensure } from "../core/db.js";
import { utcDay } from "../core/util.js";
import { readJsonBody, validPublicHttpsUrl } from "./security.js";
import { normalizeWhatsAppRecipient } from "../social/whatsapp-recipient-policy.js";

const BASE = { "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "x-frame-options": "DENY" };
function cors(req, env, extra = {}) {
  const origin = req.headers.get("origin");
  const h = { ...BASE, ...extra };
  if (env.ALLOWED_ORIGIN && origin === env.ALLOWED_ORIGIN) {
    h["access-control-allow-origin"] = origin;
    h["access-control-allow-credentials"] = "true";
    h.vary = "Origin";
  }
  return h;
}
const jsonC = (req, env, data, status = 200, extra = {}) => json(data, status, cors(req, env, extra));

async function settings(env) {
  const rows = (await env.DB.prepare("SELECT k,v FROM meta").all()).results;
  return Object.fromEntries(rows.map(r => [r.k, r.v]));
}

async function tenant(env) {
  const t = await env.DB.prepare("SELECT id FROM tenants WHERE slug='rds'").first();
  if (!t) throw new Error("tenant introuvable");
  return t.id;
}

export async function handleApi(req, env, ctx) {
  const u = new URL(req.url);
  const ip = req.headers.get("cf-connecting-ip") || "local";
  try {
    await ensure(env);
    if (u.pathname === "/api/health") return jsonC(req, env, { ok: true, day: utcDay() });
    if (req.method === "OPTIONS") { // préflight CORS pour le miroir Pages
      const h = cors(req, env);
      h["access-control-allow-methods"] = "GET,POST,PUT,OPTIONS";
      h["access-control-allow-headers"] = "content-type,x-csrf";
      h["access-control-max-age"] = "86400";
      return new Response(null, { status: 204, headers: h });
    }
    if (!isAdminPasswordConfigured(env))
      return jsonC(req, env, { error: "Accès désactivé : configurez ADMIN_PASSWORD (12 caractères minimum) dans Cloudflare." }, 503);

    if (u.pathname === "/api/login" && req.method === "POST") {
      const origin = req.headers.get("origin");
      if (!validRequestOrigin(origin, u.origin, env.ALLOWED_ORIGIN))
        return jsonC(req, env, { error: "Origine refusée" }, 403);
      let b;
      try { b = await readJsonBody(req, 16384); }
      catch (error) { return jsonC(req, env, { error: error.message }, error.status || 400); }
      const r = await login(env, b.username, b.password, ip);
      if (r.error) return jsonC(req, env, { error: r.error }, 401);
      const crossSite = !!origin && origin !== u.origin && origin === env.ALLOWED_ORIGIN;
      return jsonC(req, env, { ok: true, csrf: r.csrf, user: r.user }, 200, { "set-cookie": sessionCookie(r.token, crossSite) });
    }

    const tid = await tenant(env);
    const auth = await requireAuth(req, env);
    if (!auth) return jsonC(req, env, { error: "Non authentifié" }, 401);
    if (auth.user.role !== "admin") return jsonC(req, env, { error: "Accès refusé" }, 403);
    if (req.method !== "GET" && req.method !== "HEAD") {
      const suppliedCsrf = req.headers.get("x-csrf") || "";
      if (!validCsrfToken(suppliedCsrf, auth.csrf)) return jsonC(req, env, { error: "Jeton CSRF invalide" }, 403);
      const origin = req.headers.get("origin");
      if (!validRequestOrigin(origin, u.origin, env.ALLOWED_ORIGIN)) return jsonC(req, env, { error: "Origine refusée" }, 403);
      if (!(await rateLimit(env, `api:${ip}`, 120, 60))) return jsonC(req, env, { error: "Trop de requêtes. Réessayez dans une minute." }, 429);
      if (u.pathname === "/api/posts/generate" && !(await rateLimit(env, `generate:${ip}`, 10, 3600)))
        return jsonC(req, env, { error: "Limite de génération atteinte pour cette heure." }, 429);
      if (/^\/api\/conversations\/\d+\/reply$/.test(u.pathname) && !(await rateLimit(env, `reply:${ip}`, 30, 60)))
        return jsonC(req, env, { error: "Limite de réponses atteinte. Réessayez dans une minute." }, 429);
    }

    let requestBody = {};
    if (["POST", "PUT"].includes(req.method) && u.pathname !== "/api/logout" && req.body) {
      try { requestBody = await readJsonBody(req); }
      catch (error) { return jsonC(req, env, { error: error.message }, error.status || 400); }
    }

    if (u.pathname === "/api/logout" && req.method === "POST") {
      if (auth.token) await env.DB.prepare("DELETE FROM sessions WHERE token=?").bind(auth.token).run();
      return jsonC(req, env, { ok: true }, 200, auth.token ? { "set-cookie": logoutCookie() } : {});
    }
    if (u.pathname === "/api/state" && req.method === "GET") {
      const s = await settings(env);
      const today = await env.DB.prepare("SELECT * FROM posts WHERE tenant_id=? AND day LIKE ? ORDER BY id DESC LIMIT 1").bind(tid, utcDay() + "%").first();
      const counts = {};
      for (const row of (await env.DB.prepare("SELECT status, COUNT(*) c FROM posts WHERE tenant_id=? GROUP BY status").bind(tid).all()).results) counts[row.status] = row.c;
      const stats = {
        messages_recus: (await env.DB.prepare("SELECT COUNT(*) c FROM messages WHERE tenant_id=? AND direction='in' AND ts>datetime('now','-1 day')").bind(tid).first()).c,
        prospects: (await env.DB.prepare("SELECT COUNT(*) c FROM leads WHERE tenant_id=? AND status NOT IN ('gagné','perdu')").bind(tid).first()).c,
        transferts: (await env.DB.prepare("SELECT COUNT(*) c FROM conversations WHERE tenant_id=? AND handoff=1").bind(tid).first()).c,
        jobs_en_attente: (await env.DB.prepare("SELECT COUNT(*) c FROM jobs WHERE status IN ('pending','running')").first()).c,
      };
      const miss = missingConfig(env);
      return jsonC(req, env, { open: false, csrf: auth.csrf,
        mode: getMode(env, s), mode_source: s.mode ? "meta.mode" : "MODE", channels: channelsEnabled(env), missing: miss, today: today || null,
        counts, stats, settings: { site_url: s.site_url || env.SITE_URL, wa_cooldown_hours: s.wa_cooldown_hours || "6",
        contact_phones: JSON.parse(s.contact_phones || "null") || ["+228 93 39 25 15", "+228 90 68 10 92", "+228 79 30 90 95"],
        email: s.email || "yesborntoshine@gmail.com", location: s.location || "Agbelouvé, Togo",
        report_webhook_url: s.report_webhook_url || "" } });
    }
    const seg = u.pathname.split("/").filter(Boolean); // ["api", ...]

    if (seg[1] === "posts") {
      if (req.method === "GET") {
        const rows = (await env.DB.prepare("SELECT * FROM posts WHERE tenant_id=? ORDER BY id DESC LIMIT 50").bind(tid).all()).results;
        const chs = (await env.DB.prepare("SELECT * FROM post_channels").all()).results;
        for (const r of rows) r.channels = chs.filter(c => c.post_id === r.id);
        return jsonC(req, env, { posts: rows });
      }
      if (u.pathname === "/api/posts/generate" && req.method === "POST") {
        const id = await generatePost(env, tid, { manual: true });
        const mode = getMode(env, await settings(env));
        let published = false;
        if (mode === "auto" && id) { // publication immédiate, pas d'attente du cron
          await publishDue(env, tid);
          published = true;
        }
        const ps = id ? (await env.DB.prepare("SELECT * FROM post_channels WHERE post_id=?").bind(id).all()).results : [];
        return jsonC(req, env, { ok: true, post_id: id, mode, published, channels: ps });
      }
      const id = Number(seg[2]);
      if (seg[3] === "approve" && req.method === "POST") {
        await env.DB.prepare("UPDATE posts SET status='approved', updated_at=? WHERE id=? AND tenant_id=? AND status IN ('pending','draft','partial','error')").bind(nowISO(), id, tid).run();
        const p = await env.DB.prepare("SELECT * FROM posts WHERE id=? AND tenant_id=?").bind(id, tid).first();
        if (p) {
          const post = { id: p.id, text: p.text, image: p.image, title: p.title, status: p.status };
          const chs = (await env.DB.prepare("SELECT * FROM post_channels WHERE post_id=? AND status IN ('queued','error')").bind(id).all()).results;
          for (const pc of chs) await publishChannel(env, post, pc, p.status).catch(() => {});
        }
        await refreshPostStatuses(env, tid);
        return jsonC(req, env, { ok: true });
      }
      if (seg[3] === "reject" && req.method === "POST") {
        await env.DB.prepare("UPDATE posts SET status='rejected', updated_at=? WHERE id=? AND tenant_id=? AND status IN ('pending','draft')").bind(nowISO(), id, tid).run();
        return jsonC(req, env, { ok: true });
      }
    }
    if (seg[1] === "conversations") {
      if (req.method === "GET" && !seg[2]) {
        const rows = (await env.DB.prepare(
          `SELECT c.id, c.status, c.handoff, c.last_msg_at, ct.external_id, ct.name,
            (SELECT body FROM messages m WHERE m.conversation_id=c.id ORDER BY id DESC LIMIT 1) last_msg
           FROM conversations c JOIN contacts ct ON ct.id=c.contact_id WHERE c.tenant_id=? ORDER BY c.last_msg_at DESC LIMIT 50`).bind(tid).all()).results;
        return jsonC(req, env, { conversations: rows });
      }
      const cid = Number(seg[2]);
      if (req.method === "GET") {
        const conv = await env.DB.prepare("SELECT c.handoff,ct.external_id FROM conversations c JOIN contacts ct ON ct.id=c.contact_id WHERE c.id=? AND c.tenant_id=?").bind(cid, tid).first();
        if (!conv) return jsonC(req, env, { error: "conversation introuvable" }, 404);
        const messages = (await env.DB.prepare("SELECT * FROM messages WHERE conversation_id=? AND tenant_id=? ORDER BY id").bind(cid, tid).all()).results;
        const optOut = await env.DB.prepare("SELECT 1 AS found FROM wa_automation_optouts WHERE tenant_id=? AND phone_normalized=?")
          .bind(tid, normalizeWhatsAppRecipient(conv.external_id)).first();
        return jsonC(req, env, { messages, handoff: Number(conv.handoff) === 1, customer_stop_requested: Boolean(optOut) });
      }
      if (seg[3] === "resume" && req.method === "POST") {
        const conv = await env.DB.prepare("SELECT c.id,ct.external_id FROM conversations c JOIN contacts ct ON ct.id=c.contact_id WHERE c.id=? AND c.tenant_id=?").bind(cid, tid).first();
        if (!conv) return jsonC(req, env, { error: "conversation introuvable" }, 404);
        const optOut = await env.DB.prepare("SELECT 1 AS found FROM wa_automation_optouts WHERE tenant_id=? AND phone_normalized=?")
          .bind(tid, normalizeWhatsAppRecipient(conv.external_id)).first();
        if (optOut)
          return jsonC(req, env, { error: "Le contact a demandé l’arrêt. Attendez qu’il envoie lui-même « REPRENDRE » avant de réactiver l’automatisation." }, 409);
        await env.DB.prepare("UPDATE conversations SET handoff=0 WHERE id=? AND tenant_id=?").bind(cid, tid).run();
        await log(env, "info", "wa_automatisation_reprise", `conversation #${cid}`, tid);
        return jsonC(req, env, { ok: true });
      }
      if (seg[3] === "reply" && req.method === "POST") {
        const b = requestBody;
        const conv = await env.DB.prepare("SELECT c.*, ct.external_id FROM conversations c JOIN contacts ct ON ct.id=c.contact_id WHERE c.id=? AND c.tenant_id=?").bind(cid, tid).first();
        if (!conv) return jsonC(req, env, { error: "conversation introuvable" }, 404);
        const optOut = await env.DB.prepare("SELECT 1 AS found FROM wa_automation_optouts WHERE tenant_id=? AND phone_normalized=?")
          .bind(tid, normalizeWhatsAppRecipient(conv.external_id)).first();
        if (optOut) return jsonC(req, env, { error: "Le contact a demandé l’arrêt; aucun message ne peut être envoyé avant sa commande « REPRENDRE »." }, 409);
        const body = String(b.body || "").trim().slice(0, 4096);
        if (!body) return jsonC(req, env, { error: "Le message ne peut pas être vide." }, 400);
        // Suspendre le bot avant l’appel réseau : une génération IA en cours échouera à sa vérification finale.
        await env.DB.prepare("UPDATE conversations SET handoff=1 WHERE id=? AND tenant_id=?").bind(cid, tid).run();
        const { send } = await import("../social/whatsapp.js");
        const j = await send(env, conv.external_id, body);
        if (!j.messages?.[0]?.id) throw new Error("envoi WhatsApp sans identifiant");
        await env.DB.prepare("INSERT INTO messages(tenant_id,conversation_id,direction,external_id,body,ts) VALUES(?,?,?,?,?,?)")
          .bind(tid, cid, "out", j.messages[0].id, body, nowISO()).run();
        await log(env, "info", "wa_reponse_manuelle", `conversation #${cid}`, tid);
        return jsonC(req, env, { ok: true });
      }
    }
    if (seg[1] === "leads") {
      if (req.method === "GET") return jsonC(req, env, { leads: (await env.DB.prepare(
        `SELECT l.*, ct.external_id, ct.name FROM leads l JOIN contacts ct ON ct.id=l.contact_id WHERE l.tenant_id=? ORDER BY l.id DESC LIMIT 100`).bind(tid).all()).results });
      const id = Number(seg[2]);
      if (req.method === "PUT") {
        const b = requestBody
        await env.DB.prepare("UPDATE leads SET status=COALESCE(?,status), service=COALESCE(?,service), next_action_at=COALESCE(?,next_action_at), updated_at=? WHERE id=? AND tenant_id=?")
          .bind(b.status ?? null, b.service ?? null, b.next_action_at ?? null, nowISO(), id, tid).run();
        return jsonC(req, env, { ok: true });
      }
    }
    if (seg[1] === "services" && req.method === "GET")
      return jsonC(req, env, { services: (await env.DB.prepare("SELECT * FROM services WHERE tenant_id=? ORDER BY title").bind(tid).all()).results });
    if (seg[1] === "memory") {
      if (req.method === "GET") return jsonC(req, env, { memory: (await env.DB.prepare("SELECT * FROM memory WHERE tenant_id=? ORDER BY scope,key").bind(tid).all()).results });
      if (req.method === "PUT") {
        const b = requestBody
        await env.DB.prepare("INSERT INTO memory(tenant_id,scope,key,value,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(tenant_id,scope,key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at")
          .bind(tid, String(b.scope || "notes"), String(b.key || "").slice(0, 100), String(b.value || "").slice(0, 2000), nowISO()).run();
        return jsonC(req, env, { ok: true });
      }
    }
    if (seg[1] === "ai") {
      if (req.method === "GET") {
        const provs = (await env.DB.prepare("SELECT * FROM ai_providers ORDER BY task, priority").all()).results;
        const usage = (await env.DB.prepare("SELECT * FROM ai_usage WHERE day=?").bind(utcDay()).all()).results;
        return jsonC(req, env, { providers: provs, usage, ai_enabled: !!env.AI });
      }
      if (req.method === "PUT" && seg[2] === "providers" && seg[3]) {
        const b = requestBody
        await env.DB.prepare("UPDATE ai_providers SET model=COALESCE(?,model), enabled=COALESCE(?,enabled), daily_limit=COALESCE(?,daily_limit), priority=COALESCE(?,priority) WHERE id=?")
          .bind(b.model ?? null, b.enabled ?? null, b.daily_limit ?? null, b.priority ?? null, Number(seg[3])).run();
        return jsonC(req, env, { ok: true });
      }
    }
    if (seg[1] === "events" && req.method === "GET")
      return jsonC(req, env, { events: (await env.DB.prepare("SELECT * FROM events ORDER BY id DESC LIMIT 100").all()).results });
    if (seg[1] === "reports" && req.method === "GET")
      return jsonC(req, env, { reports: (await env.DB.prepare("SELECT * FROM reports WHERE tenant_id=? ORDER BY id DESC LIMIT 60").bind(tid).all()).results });
    if (seg[1] === "settings" && req.method === "PUT") {
      const b = requestBody
      const allowed = ["site_url", "email", "location", "wa_cooldown_hours", "report_webhook_url"];
      for (const k of allowed) if (typeof b[k] === "string") {
        if (k === "site_url" && b[k] && !validPublicHttpsUrl(b[k])) return jsonC(req, env, { error: "L'URL du site doit être une adresse HTTPS publique valide." }, 400);
        if (k === "report_webhook_url" && b[k] && !validPublicHttpsUrl(b[k])) return jsonC(req, env, { error: "Le webhook doit être une adresse HTTPS publique, sans identifiants ni adresse locale." }, 400);
        await env.DB.prepare("INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(k, b[k].slice(0, 500)).run();
      }
      if (Array.isArray(b.contact_phones)) await env.DB.prepare("INSERT INTO meta(k,v) VALUES('contact_phones',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(JSON.stringify(b.contact_phones.slice(0, 5).map(p => String(p).slice(0, 30)))).run();
      await log(env, "info", "parametres_maj", Object.keys(b).join(","), tid);
      return jsonC(req, env, { ok: true });
    }
    if (seg[1] === "media" && req.method === "GET")
      return jsonC(req, env, { media: (await env.DB.prepare("SELECT * FROM media WHERE tenant_id=? ORDER BY id DESC LIMIT 60").bind(tid).all()).results });
    return jsonC(req, env, { error: "route inconnue" }, 404);
  } catch (e) {
    await log(env, "error", "api_erreur", `${u.pathname} : ${e.message}`).catch(() => {});
    return jsonC(req, env, { error: "Erreur interne (consultez le journal)" }, 500);
  }
}
