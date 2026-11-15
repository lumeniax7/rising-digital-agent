// Rapports automatiques : quotidien 07h30 (Africa/Lome = UTC, donc cron "30 7 * * *"),
// hebdomadaire le lundi. Stockés + envoyés vers un webhook gratuit OPTIONNEL (ex. ntfy.sh).
import { utcDay, nowISO } from "../core/util.js";
import { log } from "../core/log.js";

async function aggregate(env, tenantId, sinceDays) {
  const since = `-${sinceDays} days`;
  const q = async sql => (await env.DB.prepare(sql).bind(tenantId, since).first());
  return {
    posts_publies: (await q("SELECT COUNT(*) c FROM posts WHERE tenant_id=? AND status='published' AND updated_at>datetime('now',?)" )).c,
    posts_partiels: (await q("SELECT COUNT(*) c FROM posts WHERE tenant_id=? AND status='partial' AND updated_at>datetime('now',?)")).c,
    posts_echecs: (await q("SELECT COUNT(*) c FROM posts WHERE tenant_id=? AND status IN ('error','partial') AND updated_at>datetime('now',?)")).c,
    messages_recus: (await q("SELECT COUNT(*) c FROM messages WHERE tenant_id=? AND direction='in' AND ts>datetime('now',?)")).c,
    messages_envoyes: (await q("SELECT COUNT(*) c FROM messages WHERE tenant_id=? AND direction='out' AND ts>datetime('now',?)")).c,
    nouveaux_prospects: (await q("SELECT COUNT(*) c FROM leads WHERE tenant_id=? AND created_at>datetime('now',?)")).c,
    transferts_humain: (await q("SELECT COUNT(*) c FROM conversations WHERE tenant_id=? AND handoff=1 AND last_msg_at>datetime('now',?)")).c,
    erreurs_ia: (await env.DB.prepare("SELECT COUNT(*) c FROM ai_usage WHERE day>date('now',?)").bind(since).first()).c,
  };
}

export async function dailyReport(env) {
  const tenant = await env.DB.prepare("SELECT id FROM tenants LIMIT 1").first();
  const a = await aggregate(env, tenant.id, 1);
  const day = utcDay();
  const lines = [
    `📊 RAPPORT QUOTIDIEN — Rising Digital Agent — ${day}`,
    `Publications confirmées : ${a.posts_publies} · partielles : ${a.posts_partiels} · échecs : ${a.posts_echecs}`,
    `WhatsApp : ${a.messages_recus} reçus / ${a.messages_envoyes} réponses envoyées · transferts humain : ${a.transferts_humain}`,
    `Nouveaux prospects : ${a.nouveaux_prospects} · Erreurs IA : ${a.erreurs_ia}`,
  ];
  const alerts = [];
  if (a.posts_echecs > 0) alerts.push("⚠️ Des publications ont échoué : consultez la vue Publications.");
  if (a.transferts_humain > 0) alerts.push("👤 Des conversations demandent une intervention humaine.");
  const content = lines.join("\n") + (alerts.length ? "\n" + alerts.join("\n") : "");
  await env.DB.prepare("INSERT INTO reports(tenant_id,kind,day,content) VALUES(?,?,?,?) ON CONFLICT(tenant_id,kind,day) DO UPDATE SET content=excluded.content")
    .bind(tenant.id, "daily", day, content).run();
  await log(env, "info", "rapport_quotidien", `jour=${day}`, tenant.id);
  await maybeNotify(env, content);
  if (new Date().getUTCDay() === 1) await weeklyReport(env);
}

export async function weeklyReport(env) {
  const tenant = await env.DB.prepare("SELECT id FROM tenants LIMIT 1").first();
  const a = await aggregate(env, tenant.id, 7);
  const content = [
    `🗓️ BILAN HEBDOMADAIRE — Rising Digital Agent — semaine au ${utcDay()}`,
    `Publications confirmées : ${a.posts_publies} · partielles : ${a.posts_partiels} · échecs : ${a.posts_echecs}`,
    `WhatsApp : ${a.messages_recus} reçus / ${a.messages_envoyes} envoyés · transferts humain : ${a.transferts_humain}`,
    `Nouveaux prospects : ${a.nouveaux_prospects}`,
  ].join("\n");
  await env.DB.prepare("INSERT INTO reports(tenant_id,kind,day,content) VALUES(?,?,?,?) ON CONFLICT(tenant_id,kind,day) DO UPDATE SET content=excluded.content")
    .bind(tenant.id, "weekly", utcDay(), content).run();
  await log(env, "info", "rapport_hebdomadaire", "", tenant.id);
  await maybeNotify(env, content);
}

// Notification optionnelle : webhook HTTP simple (ex. ntfy.sh gratuit). Aucun secret dans l'URL.
async function maybeNotify(env, content) {
  const url = (await env.DB.prepare("SELECT v FROM meta WHERE k='report_webhook_url'").first())?.v;
  if (!url) return;
  try {
    const r = await fetch(url, { method: "POST", body: content, headers: { "content-type": "text/plain" }, signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  } catch (e) { await log(env, "warn", "notification_echec", e.message); }
}
