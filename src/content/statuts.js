// v4.3 — Paquet de statuts WhatsApp : l'API Cloud de WhatsApp ne permet PAS de publier
// des statuts (stories). L'agent prépare donc chaque matin 3 statuts prêts à publier
// (texte + visuelle), les stocke dans les rapports et les envoie à l'admin WhatsApp
// si un numéro est configuré. Honnêteté : jamais un envoi automatique prétendu réussi.
import { utcDay } from "../core/util.js";
import { log } from "../core/log.js";

const IDEES = [
  (t, d) => `💡 Le saviez-vous ? ${t.toLowerCase()} peut changer la façon de travailler au quotidien. ${d.charAt(0).toLowerCase() + d.slice(1)}\n\n👉 Écrivez-nous pour en discuter.`,
  (t, d) => `🚀 Et si ${t.toLowerCase()} devenait votre prochain atout ?\n\n${d}\n\nRépondez à ce statut, on vous oriente gratuitement.`,
  (t, d) => `✨ Moins de complications, plus de résultats.\n\n${t} : ${d}\n\nRising Digital Solutions — Agbelouvé, Togo 🇹🇬`,
];

/** Construction pure et testable : 3 statuts à partir des 3 services les moins utilisés. */
export function buildStatusPackages(services) {
  return services.slice(0, 3).map((s, i) => ({
    service: s.title, file: s.file,
    text: `${IDEES[i % IDEES.length](s.title, s.descr || s.desc || "")}\n\n🌐 https://risingdigitalsolutions.pages.dev`,
  }));
}

export async function prepareDailyStatuses(env, tenantId) {
  const day = utcDay();
  const ex = await env.DB.prepare("SELECT 1 FROM reports WHERE tenant_id=? AND kind='statuts' AND day=?").bind(tenantId, day).first();
  if (ex) return null; // déjà préparés aujourd'hui
  const rows = (await env.DB.prepare(
    "SELECT title, file, descr FROM services WHERE tenant_id=? AND active=1 ORDER BY (last_used IS NULL) DESC, times_used, last_used LIMIT 3").bind(tenantId).all()).results;
  if (!rows.length) return null;
  const origin = env.IMAGE_BASE || "";
  const packs = buildStatusPackages(rows);
  const content = packs.map((p, i) => `STATUT ${i + 1}/${packs.length} — visuelle : ${origin.replace(/\/+$/, "")}/affiches/${p.file}\n${p.text}`).join("\n\n———\n\n")
    + `\n\n⚠️ Publication manuelle requise : l'API WhatsApp Cloud ne permet pas de publier des statuts. Ouvrez WhatsApp Business → Statut → choisissez l'image indiquée → collez le texte.`;
  await env.DB.prepare("INSERT INTO reports(tenant_id,kind,day,content) VALUES(?,?,?,?) ON CONFLICT(tenant_id,kind,day) DO UPDATE SET content=excluded.content")
    .bind(tenantId, "statuts", day, content).run();
  await log(env, "info", "statuts_pretpres", `3 paquets préparés (${packs.map(p => p.service).join(", ")})`, tenantId);
  const { notifyAdmin } = await import("../social/alerts.js");
  await notifyAdmin(env, `📱 Statuts WhatsApp du jour prêts à publier (3) — visibles dans le tableau de bord (Rapports) :\n\n${content}`).catch(() => {});
  return packs;
}
