// API du tableau de bord (/api/*).
// Deux modes : OUVERT (aucun ADMIN_PASSWORD => pas de connexion, accès direct)
// et PROTÉGÉ (ADMIN_PASSWORD >= 8 caractères => sessions + CSRF).
// Miroir GitHub Pages : si ALLOWED_ORIGIN correspond à l'origine de la requête,
// CORS + cookies SameSite=None sont activés (l'API reste hébergée par le Worker).
import { json, nowISO } from "../core/util.js";
import { log } from "../core/log.js";
import { login, requireAuth, sessionCookie, logoutCookie } from "./auth.js";
import { generatePost } from "../content/generator.js";
import { publishChannel, refreshPostStatuses } from "../social/publish.js";
import { channelsEnabled, missingConfig, getMode } from "../core/config.js";
import { ensure } from "../core/db.js";
import { utcDay } from "../core/util.js";

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
const jsonC = (req, env, data, status = 200) => json(data, status, cors(req, env));

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
    const openMode = !env.ADMIN_PASSWORD || String(env.ADMIN_PASSWORD).length < 8;

    if (u.pathname === "/api/login" && req.method === "POST") {
      if (openMode) {
        const short = env.ADMIN_PASSWORD && String(env.ADMIN_PASSWORD).length < 8;
        return jsonC(req, env, { ok: true, open: true, csrf: "open",
          note: short ? "ADMIN_PASSWORD défini mais trop court (8 caractères minimum) : mode ouvert forcé." : "Mode ouvert : aucune connexion requise." });
      }
      const b = await req.json().catch(() => ({}));
      const r = await login(env, b.username, b.password, ip);
      if (r.error) return jsonC(req, env, { error: r.error }, 401);
      return jsonC(req, env, { ok: true, csrf: r.csrf, user: r.user }, 200, { "set-cookie": sessionCookie(r.token, !!env.ALLOWED_ORIGIN) });
    }

    const tid = await tenant(env);
    let auth = null, csrf = null;
    if (openMode) {
      auth = { user: { id: 0, username: "ouvert", role: "admin", tenant_id: tid }, token: null };
      csrf = "open";
    } else {
      auth = await requireAuth(req, env);
      if (!auth) return jsonC(req, env, { error: "Non authentifié" }, 401);
      csrf = auth.csrf;
      if (req.method !== "GET") {
        if (!csrf || csrf !== auth.csrf) return jsonC(req, env, { error: "Jeton CSRF invalide" }, 403);
        const origin = req.headers.get("origin");
        if (origin && origin !== u.origin && origin !== env.ALLOWED_ORIGIN) return jsonC(req, env, { error: "Origine refusée" }, 403);
      }
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
      const miss = openMode ? missingConfig(env).filter(x => x.key !== "ADMIN_PASSWORD") : missingConfig(env);
      return jsonC(req, env, { open: openMode, csrf: openMode ? "open" : undefined,
        mode: getMode(env, s), channels: channelsEnabled(env), missing: miss, today: today || null,
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
        if (getMode(env, await settings(env)) === "auto" && id) await env.DB.prepare("INSERT OR IGNORE INTO jobs(type,payload,next_attempt_at) VALUES('publish_posts',?,?)").bind(JSON.stringify({}), nowISO()).run();
        return jsonC(req, env, { ok: true, post_id: id });
      }
      const id = Number(seg[2]);
      if (seg[3] === "approve" && req.method === "POST") {
        await env.DB.prepare("UPDATE posts SET status='approved', updated_at=? WHERE id=? AND tenant_id=? AND status IN ('pending','draft','partial','error')").bind(nowISO(), id, tid).run();
        const p = await env.DB.prepare("SELECT * FROM posts WHERE id=? AND tenant_id=?").bind(id, tid).first();
        if (p) {
          const post = { id: p.id, text: p.text, image: p.image, title: p.title };
          const chs = (await env.DB.prepare("SELECT * FROM post_channels WHERE post_id=? AND status IN ('queued','error')").bind(id).all()).results;
          for (const pc of chs) await publishChannel(env, post, pc).catch(() => {});
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
      if (req.method === "GET") return jsonC(req, env, { messages: (await env.DB.prepare("SELECT * FROM messages WHERE conversation_id=? AND tenant_id=? ORDER BY id").bind(cid, tid).all()).results });
      if (seg[3] === "reply" && req.method === "POST") {
        const b = await req.json().catch(() => ({}));
        const conv = await env.DB.prepare("SELECT c.*, ct.external_id FROM conversations c JOIN contacts ct ON ct.id=c.contact_id WHERE c.id=? AND c.tenant_id=?").bind(cid, tid).first();
        if (!conv) return jsonC(req, env, { error: "conversation introuvable" }, 404);
        const { send } = await import("../social/whatsapp.js");
        const j = await send(env, conv.external_id, String(b.body || "").slice(0, 4096));
        if (!j.messages?.[0]?.id) throw new Error("envoi WhatsApp sans identifiant");
        await env.DB.prepare("INSERT INTO messages(tenant_id,conversation_id,direction,external_id,body,ts) VALUES(?,?,?,?,?,?)")
          .bind(tid, cid, "out", j.messages[0].id, b.body, nowISO()).run();
        await log(env, "info", "wa_reponse_manuelle", `conversation #${cid}`, tid);
        return jsonC(req, env, { ok: true });
      }
    }
    if (seg[1] === "leads") {
      if (req.method === "GET") return jsonC(req, env, { leads: (await env.DB.prepare(
        `SELECT l.*, ct.external_id, ct.name FROM leads l JOIN contacts ct ON ct.id=l.contact_id WHERE l.tenant_id=? ORDER BY l.id DESC LIMIT 100`).bind(tid).all()).results });
      const id = Number(seg[2]);
      if (req.method === "PUT") {
        const b = await req.json().catch(() => ({}));
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
        const b = await req.json().catch(() => ({}));
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
        const b = await req.json().catch(() => ({}));
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
      const b = await req.json().catch(() => ({}));
      const allowed = ["site_url", "email", "location", "wa_cooldown_hours", "report_webhook_url"];
      for (const k of allowed) if (typeof b[k] === "string") {
        if (k === "report_webhook_url" && b[k] && !/^https:\/\//.test(b[k])) return jsonC(req, env, { error: "L'URL de webhook doit être en https://" }, 400);
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
