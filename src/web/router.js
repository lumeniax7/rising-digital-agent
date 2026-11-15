// API du tableau de bord (/api/*). Session + CSRF obligatoires sur les mutations.
import { json, nowISO } from "../core/util.js";
import { log } from "../core/log.js";
import { login, requireAuth, sessionCookie, logoutCookie } from "./auth.js";
import { generatePost } from "../content/generator.js";
import { publishChannel, refreshPostStatuses } from "../social/publish.js";
import { derivePostStatus } from "../core/state.js";
import { channelsEnabled, missingConfig, getMode } from "../core/config.js";
import { utcDay } from "../core/util.js";

const HDRS = { "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "x-frame-options": "DENY" };

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
  const noStore = { "cache-control": "no-store" };
  try {
    if (u.pathname === "/api/health") return json({ ok: true, day: utcDay() }, 200, noStore);
    if (u.pathname === "/api/login" && req.method === "POST") {
      const b = await req.json().catch(() => ({}));
      const r = await login(env, b.username, b.password, ip);
      if (r.error) return json({ error: r.error }, 401, noStore);
      return json({ ok: true, csrf: r.csrf, user: r.user }, 200, { ...noStore, "set-cookie": sessionCookie(r.token) });
    }
    const auth = await requireAuth(req, env);
    if (!auth) return json({ error: "Non authentifié" }, 401, noStore);
    const csrf = req.headers.get("x-csrf");
    if (req.method !== "GET") {
      if (!csrf || csrf !== auth.csrf) return json({ error: "Jeton CSRF invalide" }, 403, noStore);
      const origin = req.headers.get("origin");
      if (origin && origin !== u.origin) return json({ error: "Origine refusée" }, 403, noStore);
    }
    const tid = await tenant(env);
    const seg = u.pathname.split("/").filter(Boolean); // ["api", ...]

    if (u.pathname === "/api/logout" && req.method === "POST") {
      await env.DB.prepare("DELETE FROM sessions WHERE token=?").bind(auth.token).run();
      return json({ ok: true }, 200, { ...noStore, "set-cookie": logoutCookie() });
    }
    if (u.pathname === "/api/state" && req.method === "GET") {
      const s = await settings(env);
      const today = await env.DB.prepare("SELECT * FROM posts WHERE tenant_id=? AND day=?").bind(tid, utcDay()).first();
      const counts = {};
      for (const row of (await env.DB.prepare("SELECT status, COUNT(*) c FROM posts WHERE tenant_id=? GROUP BY status").bind(tid).all()).results) counts[row.status] = row.c;
      const stats = {
        messages_recus: (await env.DB.prepare("SELECT COUNT(*) c FROM messages WHERE tenant_id=? AND direction='in' AND ts>datetime('now','-1 day')").bind(tid).first()).c,
        prospects: (await env.DB.prepare("SELECT COUNT(*) c FROM leads WHERE tenant_id=? AND status NOT IN ('gagné','perdu')").bind(tid).first()).c,
        transferts: (await env.DB.prepare("SELECT COUNT(*) c FROM conversations WHERE tenant_id=? AND handoff=1").bind(tid).first()).c,
        jobs_en_attente: (await env.DB.prepare("SELECT COUNT(*) c FROM jobs WHERE status IN ('pending','running')").first()).c,
      };
      return json({ mode: getMode(env, s), channels: channelsEnabled(env), missing: missingConfig(env), today: today || null,
        counts, stats, settings: { site_url: s.site_url || env.SITE_URL, wa_cooldown_hours: s.wa_cooldown_hours || "6",
        contact_phones: JSON.parse(s.contact_phones || "null") || ["+228 93 39 25 15", "+228 90 68 10 92", "+228 79 30 90 95"],
        email: s.email || "yesborntoshine@gmail.com", location: s.location || "Agbelouvé, Togo",
        report_webhook_url: s.report_webhook_url || "" } }, 200, noStore);
    }
    if (seg[1] === "posts") {
      if (req.method === "GET") {
        const rows = (await env.DB.prepare("SELECT * FROM posts WHERE tenant_id=? ORDER BY id DESC LIMIT 50").bind(tid).all()).results;
        const chs = (await env.DB.prepare("SELECT * FROM post_channels").all()).results;
        for (const r of rows) r.channels = chs.filter(c => c.post_id === r.id);
        return json({ posts: rows }, 200, noStore);
      }
      if (u.pathname === "/api/posts/generate" && req.method === "POST") {
        const id = await generatePost(env, tid, { manual: true });
        if (getMode(env, await settings(env)) === "auto" && id) await env.DB.prepare("INSERT OR IGNORE INTO jobs(type,payload,next_attempt_at) VALUES('publish_posts',?,?)").bind(JSON.stringify({}), nowISO()).run();
        return json({ ok: true, post_id: id }, 200, noStore);
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
        return json({ ok: true }, 200, noStore);
      }
      if (seg[3] === "reject" && req.method === "POST") {
        await env.DB.prepare("UPDATE posts SET status='rejected', updated_at=? WHERE id=? AND tenant_id=? AND status IN ('pending','draft')").bind(nowISO(), id, tid).run();
        return json({ ok: true }, 200, noStore);
      }
    }
    if (seg[1] === "conversations") {
      if (req.method === "GET" && !seg[2]) {
        const rows = (await env.DB.prepare(
          `SELECT c.id, c.status, c.handoff, c.last_msg_at, ct.external_id, ct.name,
            (SELECT body FROM messages m WHERE m.conversation_id=c.id ORDER BY id DESC LIMIT 1) last_msg
           FROM conversations c JOIN contacts ct ON ct.id=c.contact_id WHERE c.tenant_id=? ORDER BY c.last_msg_at DESC LIMIT 50`).bind(tid).all()).results;
        return json({ conversations: rows }, 200, noStore);
      }
      const cid = Number(seg[2]);
      if (req.method === "GET") return json({ messages: (await env.DB.prepare("SELECT * FROM messages WHERE conversation_id=? AND tenant_id=? ORDER BY id").bind(cid, tid).all()).results }, 200, noStore);
      if (seg[3] === "reply" && req.method === "POST") {
        const b = await req.json().catch(() => ({}));
        const conv = await env.DB.prepare("SELECT c.*, ct.external_id FROM conversations c JOIN contacts ct ON ct.id=c.contact_id WHERE c.id=? AND c.tenant_id=?").bind(cid, tid).first();
        if (!conv) return json({ error: "conversation introuvable" }, 404, noStore);
        const { send } = await import("../social/whatsapp.js");
        const j = await send(env, conv.external_id, String(b.body || "").slice(0, 4096));
        if (!j.messages?.[0]?.id) throw new Error("envoi WhatsApp sans identifiant");
        await env.DB.prepare("INSERT INTO messages(tenant_id,conversation_id,direction,external_id,body,ts) VALUES(?,?,?,?,?,?)")
          .bind(tid, cid, "out", j.messages[0].id, b.body, nowISO()).run();
        await log(env, "info", "wa_reponse_manuelle", `conversation #${cid}`, tid);
        return json({ ok: true }, 200, noStore);
      }
    }
    if (seg[1] === "leads") {
      if (req.method === "GET") return json({ leads: (await env.DB.prepare(
        `SELECT l.*, ct.external_id, ct.name FROM leads l JOIN contacts ct ON ct.id=l.contact_id WHERE l.tenant_id=? ORDER BY l.id DESC LIMIT 100`).bind(tid).all()).results }, 200, noStore);
      const id = Number(seg[2]);
      if (req.method === "PUT") {
        const b = await req.json().catch(() => ({}));
        await env.DB.prepare("UPDATE leads SET status=COALESCE(?,status), service=COALESCE(?,service), next_action_at=COALESCE(?,next_action_at), updated_at=? WHERE id=? AND tenant_id=?")
          .bind(b.status ?? null, b.service ?? null, b.next_action_at ?? null, nowISO(), id, tid).run();
        return json({ ok: true }, 200, noStore);
      }
    }
    if (seg[1] === "services" && req.method === "GET")
      return json({ services: (await env.DB.prepare("SELECT * FROM services WHERE tenant_id=? ORDER BY title").bind(tid).all()).results }, 200, noStore);
    if (seg[1] === "memory") {
      if (req.method === "GET") return json({ memory: (await env.DB.prepare("SELECT * FROM memory WHERE tenant_id=? ORDER BY scope,key").bind(tid).all()).results }, 200, noStore);
      if (req.method === "PUT") {
        const b = await req.json().catch(() => ({}));
        await env.DB.prepare("INSERT INTO memory(tenant_id,scope,key,value,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(tenant_id,scope,key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at")
          .bind(tid, String(b.scope || "notes"), String(b.key || "").slice(0, 100), String(b.value || "").slice(0, 2000), nowISO()).run();
        return json({ ok: true }, 200, noStore);
      }
    }
    if (seg[1] === "ai") {
      if (req.method === "GET") {
        const provs = (await env.DB.prepare("SELECT * FROM ai_providers ORDER BY task, priority").all()).results;
        const usage = (await env.DB.prepare("SELECT * FROM ai_usage WHERE day=?").bind(utcDay()).all()).results;
        return json({ providers: provs, usage, ai_enabled: !!env.AI }, 200, noStore);
      }
      if (req.method === "PUT" && seg[2] === "providers" && seg[3]) {
        const b = await req.json().catch(() => ({}));
        await env.DB.prepare("UPDATE ai_providers SET model=COALESCE(?,model), enabled=COALESCE(?,enabled), daily_limit=COALESCE(?,daily_limit), priority=COALESCE(?,priority) WHERE id=?")
          .bind(b.model ?? null, b.enabled ?? null, b.daily_limit ?? null, b.priority ?? null, Number(seg[3])).run();
        return json({ ok: true }, 200, noStore);
      }
    }
    if (seg[1] === "events" && req.method === "GET")
      return json({ events: (await env.DB.prepare("SELECT * FROM events ORDER BY id DESC LIMIT 100").all()).results }, 200, noStore);
    if (seg[1] === "reports" && req.method === "GET")
      return json({ reports: (await env.DB.prepare("SELECT * FROM reports WHERE tenant_id=? ORDER BY id DESC LIMIT 60").bind(tid).all()).results }, 200, noStore);
    if (seg[1] === "settings" && req.method === "PUT") {
      const b = await req.json().catch(() => ({}));
      const allowed = ["site_url", "email", "location", "wa_cooldown_hours", "report_webhook_url"];
      for (const k of allowed) if (typeof b[k] === "string") {
        if (k === "report_webhook_url" && b[k] && !/^https:\/\//.test(b[k])) return json({ error: "L'URL de webhook doit être en https://" }, 400, noStore);
        await env.DB.prepare("INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(k, b[k].slice(0, 500)).run();
      }
      if (Array.isArray(b.contact_phones)) await env.DB.prepare("INSERT INTO meta(k,v) VALUES('contact_phones',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(JSON.stringify(b.contact_phones.slice(0, 5).map(p => String(p).slice(0, 30)))).run();
      await log(env, "info", "parametres_maj", Object.keys(b).join(","), tid);
      return json({ ok: true }, 200, noStore);
    }
    if (seg[1] === "media" && req.method === "GET")
      return json({ media: (await env.DB.prepare("SELECT * FROM media WHERE tenant_id=? ORDER BY id DESC LIMIT 60").bind(tid).all()).results }, 200, noStore);
    return json({ error: "route inconnue" }, 404, noStore);
  } catch (e) {
    await log(env, "error", "api_erreur", `${u.pathname} : ${e.message}`).catch(() => {});
    return json({ error: "Erreur interne (consultez le journal)" }, 500, noStore);
  }
}
