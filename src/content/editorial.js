// Moteur éditorial : rotation équitable des 27 services, piliers de contenu, anti-répétition.
import { jaccard } from "../core/util.js";

export const PILLARS = [
  "donner un conseil pratique sur l'IA ou le numérique",
  "présenter ce service de façon claire et concrète",
  "expliquer comment ce service aide un entrepreneur, une ONG ou une PME",
  "inviter à écrire sur WhatsApp pour demander un devis",
];

export async function recentPosts(env, tenantId, n = 7) {
  return (await env.DB.prepare("SELECT text FROM posts WHERE tenant_id=? ORDER BY id DESC LIMIT ?").bind(tenantId, n).all()).results.map(r => r.text);
}

// Service le moins récemment utilisé (rotation équitable), parmis les actifs.
export async function pickService(env, tenantId, dayNumber) {
  const rows = (await env.DB.prepare(
    "SELECT * FROM services WHERE tenant_id=? AND active=1 ORDER BY (last_used IS NULL) DESC, times_used, last_used LIMIT 5").bind(tenantId).all()).results;
  if (!rows.length) throw new Error("catalogue de services vide");
  return rows[dayNumber % Math.max(rows.length, 1)] ?? rows[0];
}

export async function markServiceUsed(env, tenantId, serviceId) {
  await env.DB.prepare("UPDATE services SET times_used=times_used+1, last_used=? WHERE id=?").bind(new Date().toISOString(), serviceId).run();
}

// Un texte trop proche d'une publication récente est rejeté (seuil Jaccard 0.55).
export function tooSimilar(candidate, recent, threshold = 0.55) {
  return recent.some(r => jaccard(candidate, r) > threshold);
}
