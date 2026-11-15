// Utilitaires partagés — code 100% testable hors Workers (node --test).
export const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const nowISO = () => new Date().toISOString();
export const utcDay = (d = new Date()) => d.toISOString().slice(0, 10);
// Africa/Lome = UTC+0 toute l'année : l'heure de Lomé EST l'heure UTC (07h00 Lomé = 07h00 UTC).
export const lomeStamp = (d = new Date()) => d.toISOString().replace("T", " ").slice(0, 16);

export function safeEq(a, b) {
  a = String(a ?? ""); b = String(b ?? "");
  const n = Math.max(a.length, b.length);
  let d = a.length ^ b.length;
  for (let i = 0; i < n; i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return d === 0;
}

export const SECRETS = ["FB_PAGE_TOKEN", "IG_TOKEN", "WA_TOKEN", "WA_APP_SECRET", "ADMIN_PASSWORD", "WA_VERIFY", "TIKTOK_TOKEN", "REPORT_WEBHOOK_TOKEN"];
export function redact(text, env = {}) {
  let t = String(text ?? "");
  for (const k of SECRETS) if (env[k]) t = t.split(env[k]).join("[masqué]");
  return t.replace(/EAA[A-Za-z0-9]{20,}/g, "[masqué]").replace(/\b\d{10,15}\b/g, "[num masqué]").slice(0, 500);
}

// Backoff exponentiel avec jitter (jamais 2 retries simultanés à la même seconde).
export const backoffMs = (attempt, base = 60_000) => Math.min(base * 2 ** attempt, 6 * 3600_000) * (0.7 + Math.random() * 0.6);

// Similarité de texte (Jaccard sur mots > 3 lettres, accents ignorés) pour l'anti-répétition.
export function normWords(s) {
  return new Set(String(s ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").split(/[^a-z0-9]+/).filter(w => w.length > 3));
}
export function jaccard(a, b) {
  const A = normWords(a), B = normWords(b);
  if (!A.size || !B.size) return 0;
  let i = 0; for (const w of A) if (B.has(w)) i++;
  return i / (A.size + B.size - i);
}

export const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json;charset=utf-8", "cache-control": "no-store", ...headers } });
