// Rapports automatiques : quotidien 07h30 (Africa/Lome = UTC, donc cron "30 7 * * *"),
// hebdomadaire le lundi. Stockés + envoyés vers un webhook gratuit OPTIONNEL (ex. ntfy.sh).
import { utcDay, nowISO } from "../core/util.js";
import { log } from "../core/log.js";

async function aggregate(env, tenantId, sinceDays) {
  const since = `-${sinceDays} days`;
  const q = async sql => (await env.DB.prepare(sql).bind(tenantId, since).first());
  // v4.3.1 : métriques PAR CANAL, sans double comptage.
  // Un post "partial" a réussi sur un canal et échoué sur l'autre : les échecs sont comptés
  // sur les post_channels (par canal), jamais en double au niveau des posts.
  const canal = async ch => ({
    ok: (await q(`SELECT COUNT(DISTINCT pc.post_id) c FROM post_channels pc JOIN posts p ON p.id=pc.post_id
      WHERE pc.channel='${ch}' AND pc.status='published' AND p.tenant_id=? AND pc.updated_at>datetime('now',?)`)).c,
    echecs: (await q(`SELECT COUNT(*) c FROM post_channels pc JOIN posts p ON p.id=pc.post_id
      WHERE pc.channel='${ch}' AND pc.status IN ('error','manual_required') AND p.tenant_id=? AND pc.updated_at>datetime('now',?)`)).c,
    dernier_erreur: (await env.DB.prepare(`SELECT last_error FROM post_channels pc JOIN posts p ON p.id=pc.post_id
      WHERE pc.channel='${ch}' AND pc.status IN ('error','manual_required') AND p.tenant_id=? AND pc.updated_at>datetime('now',?)
        AND last_error IS NOT NULL AND last_error != '' ORDER BY pc.updated_at DESC LIMIT 1`).bind(tenantId, since).first().catch(() => null))?.last_error || null,
  });
  return {
    posts_publies: (await q("SELECT COUNT(*) c FROM posts WHERE tenant_id=? AND status='published' AND updated_at>datetime('now',?)" )).c,
    posts_partiels: (await q("SELECT COUNT(*) c FROM posts WHERE tenant_id=? AND status='partial' AND updated_at>datetime('now',?)")).c,
    facebook: await canal("facebook"),
    instagram: await canal("instagram"),
    messages_recus: (await q("SELECT COUNT(*) c FROM messages WHERE tenant_id=? AND direction='in' AND ts>datetime('now',?)")).c,
    messages_envoyes: (await q("SELECT COUNT(*) c FROM messages WHERE tenant_id=? AND direction='out' AND ts>datetime('now',?)")).c,
    nouveaux_prospects: (await q("SELECT COUNT(*) c FROM leads WHERE tenant_id=? AND created_at>datetime('now',?)")).c,
    transferts_humain: (await q("SELECT COUNT(*) c FROM conversations WHERE tenant_id=? AND handoff=1 AND last_msg_at>datetime('now',?)")).c,
    erreurs_ia: (await env.DB.prepare("SELECT COUNT(*) c FROM ai_usage WHERE day>date('now',?)").bind(since).first()).c,
  };
}

// Ligne "Publications" par canal : succès / échecs + la DERNIÈRE erreur brute (actionnable).
export function publicationLine(prefix, a) {
  const f = a.facebook, i = a.instagram;
  let line = `${prefix} Facebook : ${f.ok} OK / ${f.echecs} échec(s) · Instagram : ${i.ok} OK / ${i.echecs} échec(s)`;
  const err = f.dernier_erreur || i.dernier_erreur;
  if (err) line += `\n   ↳ dernier échec : ${String(err).slice(0, 160)}`;
  return line;
}

export async function dailyReport(env) {
  const tenant = await env.DB.prepare("SELECT id FROM tenants LIMIT 1").first();
  const a = await aggregate(env, tenant.id, 1);
  const day = utcDay();
  const lines = [
    `📊 RAPPORT QUOTIDIEN — Rising Digital Agent — ${day}`,
    publicationLine("Publications —", a),
    `WhatsApp : ${a.messages_recus} reçus / ${a.messages_envoyes} réponses envoyées · transferts humain : ${a.transferts_humain}`,
    `Nouveaux prospects : ${a.nouveaux_prospects} · Erreurs IA : ${a.erreurs_ia}`,
  ];
  const alerts = [];
  if (a.facebook.echecs > 0 || a.instagram.echecs > 0) alerts.push("⚠️ Des publications ont échoué : consultez la vue Publications (le dernier message d'erreur est cité ci-dessus).");
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
  // v4.3 : les 3 sujets les plus demandés sur WhatsApp (7 jours) — pour piloter l'offre.
  let sujets = "aucun sujet marquant";
  try {
    const top = (await env.DB.prepare("SELECT service, COUNT(*) c FROM leads WHERE tenant_id=? AND created_at>datetime('now','-7 days') AND service IS NOT NULL GROUP BY service ORDER BY c DESC LIMIT 3").bind(tenant.id).all()).results || [];
    if (top.length) sujets = top.map(r => `${r.service} (${r.c})`).join(", ");
  } catch { /* statistique indicative : jamais bloquante */ }
  const content = [
    `🗓️ BILAN HEBDOMADAIRE — Rising Digital Agent — semaine au ${utcDay()}`,
    publicationLine("Publications —", a),
    `WhatsApp : ${a.messages_recus} reçus / ${a.messages_envoyes} envoyés · transferts humain : ${a.transferts_humain}`,
    `Nouveaux prospects : ${a.nouveaux_prospects}`,
    `Sujets les plus demandés (7 j) : ${sujets}`,
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

// ---- v4.3.2 : résumé individuel par conversation, envoyé à l'admin (matin + soir) ----

// Construction PURE (testable) du bloc résumé : une ligne par conversation active,
// avec dernier message, statut du prospect et action suggérée (heuristique honnête).
export function buildDigestBlock(rows) {
  if (!rows.length) return null;
  const lines = rows.map(r => {
    const action = r.handoff ? "👉 traiter en priorité (demande humain)"
      : (r.recv > r.sent && ["nouveau", null].includes(r.lead_status)) ? "👉 à recontacter : besoin exprimé sans réponse d'équipe"
      : (r.lead_status && !["gagné", "perdu"].includes(r.lead_status)) ? "👀 surveiller / préparer une proposition"
      : "✓ suivre normalement";
    const last = r.last_msg ? String(r.last_msg).replace(/\s+/g, " ").slice(0, 120) : "(vide)";
    const lead = r.lead_status ? `${r.lead_status}${r.lead_service ? ` — ${r.lead_service}` : ""}` : "aucun";
    return `📞 +${r.external_id} — ${r.recv} reçu(s) / ${r.sent} envoyé(s)\n   Prospect : ${lead}\n   Dernier message : « ${last} »\n   ${action}`;
  });
  return lines.join("\n");
}

export async function conversationDigest(env, tenantId, sinceHours, label) {
  const since = `-${sinceHours} hours`;
  const rows = (await env.DB.prepare(
    `SELECT c.id, ct.external_id, ct.name, c.handoff,
      (SELECT COUNT(*) FROM messages m WHERE m.conversation_id=c.id AND m.direction='in' AND m.ts>datetime('now',?)) recv,
      (SELECT COUNT(*) FROM messages m WHERE m.conversation_id=c.id AND m.direction='out' AND m.ts>datetime('now',?)) sent,
      (SELECT body FROM messages m WHERE m.conversation_id=c.id AND m.direction='in' ORDER BY id DESC LIMIT 1) last_msg,
      (SELECT status FROM leads l WHERE l.contact_id=c.contact_id AND l.tenant_id=c.tenant_id ORDER BY id DESC LIMIT 1) lead_status,
      (SELECT service FROM leads l WHERE l.contact_id=c.contact_id AND l.tenant_id=c.tenant_id ORDER BY id DESC LIMIT 1) lead_service
     FROM conversations c JOIN contacts ct ON ct.id=c.contact_id
     WHERE c.tenant_id=? AND c.last_msg_at>datetime('now',?) ORDER BY c.last_msg_at DESC LIMIT 30`)
    .bind(since, since, tenantId, since).all()).results || [];
  const block = buildDigestBlock(rows);
  const content = block
    ? `📋 ${label} — ${rows.length} conversation(s) active(s) sur ${sinceHours} h\n\n${block}\n\n— Rising Digital Agent`
    : `📋 ${label} — aucune conversation active sur les ${sinceHours} dernières heures.`;
  await env.DB.prepare("INSERT INTO reports(tenant_id,kind,day,content) VALUES(?,?,?,?,?) ON CONFLICT(tenant_id,kind,day) DO UPDATE SET content=excluded.content")
    .bind(tenantId, `digest_${label.toLowerCase().split(" ")[0]}`, utcDay(), content).run();
  const { notifyAdmin } = await import("../social/alerts.js");
  await notifyAdmin(env, content);
  return rows.length;
}
