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


/**
 * Surveillance de file exécutée par le cron Worker. Les alertes sont agrégées,
 * dédupliquées dans D1 et ne contiennent aucune donnée de contact.
 */
export async function monitorWhatsAppQueue(env) {
  const destination = (await env.DB.prepare("SELECT v FROM meta WHERE k='report_webhook_url'").first())?.v;
  if (!destination) return { configured: false, notified: false };

  const threshold = Math.max(1, Math.min(100, Number(env.WA_ALERT_FAILED_THRESHOLD) || 1));
  const inbox = (await env.DB.prepare(`SELECT
    SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
    SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending,
    SUM(CASE WHEN status='processing' AND claimed_at<=datetime('now','-10 minutes') THEN 1 ELSE 0 END) AS stale_processing,
    MIN(CASE WHEN status='pending' THEN created_at END) AS oldest_pending
    FROM wa_inbox`).first()) || {};
  const template = (await env.DB.prepare(`SELECT
    SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
    SUM(CASE WHEN status='processing' AND claimed_at<=datetime('now','-10 minutes') THEN 1 ELSE 0 END) AS stale_processing
    FROM wa_template_queue`).first()) || {};
  const incidents = [];
  const failed = Number(inbox.failed || 0) + Number(template.failed || 0);
  const staleProcessing = Number(inbox.stale_processing || 0) + Number(template.stale_processing || 0);
  const oldestPendingRaw = String(inbox.oldest_pending || "");
  const oldestPendingIso = oldestPendingRaw && /(?:Z|[+-]\d{2}:?\d{2})$/i.test(oldestPendingRaw)
    ? oldestPendingRaw : oldestPendingRaw.replace(" ", "T") + "Z";
  const oldestPendingMs = oldestPendingIso ? Date.parse(oldestPendingIso) : NaN;
  const oldPending = Number.isFinite(oldestPendingMs) && Date.now() - oldestPendingMs > 60 * 60_000;
  if (failed >= threshold) incidents.push("échecs");
  if (staleProcessing > 0) incidents.push("processing_bloqué");
  if (oldPending) incidents.push("pending_ancien");

  const fingerprint = incidents.sort().join(",");
  const previous = (await env.DB.prepare("SELECT v FROM meta WHERE k='wa_queue_alert_fingerprint'").first())?.v || "";
  if (fingerprint === previous) return { configured: true, notified: false, incidents: fingerprint };
  if (!fingerprint && !previous) return { configured: true, notified: false, incidents: "" };

  const content = fingerprint
    ? `Alerte WhatsApp Rising Digital Agent : incidents=${fingerprint}; échecs=${failed}; pending=${Number(inbox.pending || 0)}; processing_expirés=${staleProcessing}. Aucun contenu de message ni numéro client n’est inclus.`
    : "Rétablissement WhatsApp Rising Digital Agent : les alertes de file précédentes ne sont plus détectées.";
  try {
    const response = await fetch(destination, { method: "POST", body: content,
      headers: { "content-type": "text/plain" }, signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    await env.DB.prepare(`INSERT INTO meta(k,v) VALUES('wa_queue_alert_fingerprint',?)
      ON CONFLICT(k) DO UPDATE SET v=excluded.v`).bind(fingerprint).run();
    await log(env, "info", "wa_alerte_webhook_envoyee", `incidents=${fingerprint || "aucun"}`);
    return { configured: true, notified: true, incidents: fingerprint };
  } catch (error) {
    await log(env, "warn", "wa_alerte_webhook_echec", String(error?.message || "erreur réseau").slice(0, 120));
    return { configured: true, notified: false, incidents: fingerprint, error: true };
  }
}
