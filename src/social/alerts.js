// v4.3 — Alertes admin : l'agent prévient l'administrateur sur WhatsApp quand quelque
// chose a besoin d'un humain (publication en échec définitif, statuts prêts, etc.).
// Le numéro admin est optionnel : sans configuration, aucune alerte n'est envoyée et
// rien ne casse — les informations restent dans le journal et les rapports.
import { log } from "../core/log.js";

export async function getAdminPhone(env) {
  const fromEnv = String(env.ADMIN_WHATSAPP || "").trim();
  if (/^\d{5,20}$/.test(fromEnv)) return fromEnv;
  const row = await env.DB.prepare("SELECT v FROM meta WHERE k='admin_whatsapp'").first().catch(() => null);
  const v = String(row?.v || "").trim();
  return /^\d{5,20}$/.test(v) ? v : null;
}

export async function notifyAdmin(env, text) {
  const to = await getAdminPhone(env);
  if (!to) return false; // pas de numéro admin configuré : silence assumé, pas d'échec
  try {
    const { send } = await import("./whatsapp.js");
    const r = await send(env, to, String(text).slice(0, 1000));
    await log(env, "info", "alerte_admin_envoyee", String(text).slice(0, 80));
    return !!(r?.messages?.[0]?.id);
  } catch (e) {
    await log(env, "warn", "alerte_admin_echec", String(e?.message ?? e).slice(0, 200)).catch(() => {});
    return false;
  }
}
