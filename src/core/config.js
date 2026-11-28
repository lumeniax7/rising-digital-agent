import { safeEq } from "./util.js";

export const MODES = ["test", "approval", "auto"];
export const CHANNELS = ["facebook", "instagram", "tiktok", "whatsapp"];
// Version Graph par défaut. À vérifier avant toute mise à jour :
// https://developers.facebook.com/docs/graph-api/changelog
export const GRAPH_VERSION_DEFAULT = "v23.0";

export function getMode(env, settings = {}) {
  const v = String(settings.mode || env.MODE || "test").toLowerCase();
  return MODES.includes(v) ? v : "test";
}

// Quels canaux sont réellement configurés (secrets présents) — JAMAIS un faux succès.
export function channelsEnabled(env) {
  return {
    facebook: !!(env.FB_PAGE_ID && env.FB_PAGE_TOKEN),
    instagram: !!(env.IG_USER_ID && (env.IG_TOKEN || env.FB_PAGE_TOKEN)),
    // Publication directe TikTok = en attente d'approbation de l'API Content Posting (voir docs/TIKTOK.md).
    // TIKTOK_TOKEN, s'il existe, ne sert qu'aux opérations vérifiées ; sans autorisation => export manuel.
    tiktok: false,
    whatsapp: !!(env.WA_TOKEN && env.WA_PHONE_ID && env.WA_VERIFY && env.WA_APP_SECRET),
  };
}

// Liste des secrets attendus et de leur rôle — pour la validation avant tâche.
export const SECRET_SPECS = [
  { key: "ADMIN_PASSWORD", usage: "Tableau de bord (12 caractères minimum)", required: true },
  { key: "FB_PAGE_ID", usage: "Publication Facebook", required: false },
  { key: "FB_PAGE_TOKEN", usage: "Publication Facebook (+ Instagram si IG_TOKEN absent)", required: false },
  { key: "IG_USER_ID", usage: "Publication Instagram", required: false },
  { key: "IG_TOKEN", usage: "Publication Instagram (optionnel, sinon FB_PAGE_TOKEN)", required: false },
  { key: "WA_TOKEN", usage: "WhatsApp Cloud API", required: false },
  { key: "WA_PHONE_ID", usage: "WhatsApp Cloud API", required: false },
  { key: "WA_VERIFY", usage: "Vérification du webhook WhatsApp", required: false },
  { key: "WA_APP_SECRET", usage: "Signature HMAC obligatoire des webhooks WhatsApp", required: false },
];

export function missingConfig(env) {
  const out = SECRET_SPECS.filter(s => s.required && !env[s.key]).map(s => ({ key: s.key, usage: s.usage }));
  if (env.ADMIN_PASSWORD && env.ADMIN_PASSWORD.length < 12) out.push({ key: "ADMIN_PASSWORD", usage: "Trop court : 12 caractères minimum" });
  if ((env.WA_TOKEN || env.WA_PHONE_ID || env.WA_VERIFY) && !env.WA_APP_SECRET)
    out.push({ key: "WA_APP_SECRET", usage: "Obligatoire pour valider les POST webhook WhatsApp" });
  return out;
}
