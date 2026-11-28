// v4.3 — Brèves du jour : un appel IA unique le matin, stocké et injecté dans les réponses
// WhatsApp de la journée. Permet au bot de parler du contexte (business, numérique, Togo)
// sans inventer d'actualité : la brève est générée une fois, réutilisée toute la journée.
import { log } from "../core/log.js";
import { runAI } from "../ai/router.js";
import { utcDay } from "../core/util.js";

// Le briefing est volontairement EVERGREEN (pas d'actualité datée) : le modèle n'a pas
// d'accès web, donc on génère des repères utiles et vrais toute l'année, jamais un faux événement.
const PROMPT = `Tu prépares le "briefing du jour" de l'assistant WhatsApp de Rising Digital Solutions (studio numérique à Agbelouvé, Togo).
Écris 3 repères courts et VRAIS toute l'année (jamais d'événement daté, jamais de statistique que tu n'es pas sûr de connaître), un par ligne, précédés de "•", sur : 1) une tendance numérique utile aux entrepreneurs africains ; 2) un conseil concret de productivité ; 3) une idée simple de communication pour une petite activité.
Chaque ligne : 15 mots maximum, français, concret. Aucun chiffre inventé, aucun lien, aucune promesse. Réponds uniquement avec les 3 lignes.`;

export async function generateBriefing(env, tenantId) {
  const day = utcDay();
  const ex = await env.DB.prepare("SELECT v FROM meta WHERE k='briefing_du_jour'").first();
  if (ex?.v && String(ex.v).startsWith(`${day}|`)) return String(ex.v).slice(day.length + 1); // déjà fait aujourd'hui
  const ai = await runAI(env, "idea", { prompt: PROMPT, max_tokens: 220 });
  if (!ai.ok) { await log(env, "warn", "briefing_indisponible", ai.reason, tenantId); return null; }
  const lines = String(ai.text).split("\n").map(l => l.trim()).filter(l => l.startsWith("•")).slice(0, 3);
  if (!lines.length) { await log(env, "warn", "briefing_rejete", "format inattendu", tenantId); return null; }
  const briefing = lines.join("\n");
  await env.DB.prepare("INSERT INTO meta(k,v) VALUES('briefing_du_jour',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v")
    .bind(`${day}|${briefing}`).run();
  await log(env, "info", "briefing_genere", `${lines.length} lignes`, tenantId);
  return briefing;
}

/** Lecture sûre pour l'injecteur de prompt : null si absent ou d'un autre jour. */
export function parseBriefing(raw) {
  const s = String(raw ?? "");
  if (!s.includes("|")) return null;
  const [day, ...rest] = s.split("|");
  return day === utcDay() && rest.length ? rest.join("|") : null;
}
