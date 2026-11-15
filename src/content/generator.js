// Générateur de publications : IA avec contrôles + repli par modèle de gabarit (honnête, jamais faux).
import { log } from "../core/log.js";
import { runAI } from "../ai/router.js";
import { utcDay, nowISO, jaccard } from "../core/util.js";
import { getMode } from "../core/config.js";
import { PILLARS, pickService, markServiceUsed, recentPosts, tooSimilar } from "./editorial.js";

const PHONE_DEFAULT = "+228 93 39 25 15";
const BAD = /(\d|fcfa|cfa|€|\$|%|garanti|témoignage|satisfait|http|www\.)/i;

export function templatePost(svc, pillarIdx, phone, siteUrl) {
  const lines = [
    "Un conseil : adoptez un seul outil numérique à la fois et maîtrisez-le à fond avant d'en ajouter un autre.",
    `${svc.title} : ${svc.desc}`,
    "Entrepreneurs, ONG et PME : des solutions numériques simples, concrètes et adaptées à votre réalité.",
    "Un besoin sur ce sujet ? Écrivez-nous, nous étudions votre projet avant tout devis.",
  ];
  const body = `${lines[pillarIdx % 4]}\n\n${svc.desc}\n\n📱 ${phone}\n🌐 ${siteUrl}`;
  return { text: body, generator: "gabarit" };
}

export async function checkFile(env, file) {
  try {
    const r = await env.ASSETS.fetch(new Request("https://assets.local/affiches/" + file, { method: "HEAD" }));
    if (!r.ok) return `HTTP ${r.status}`;
    const t = r.headers.get("content-type") || "";
    return t.startsWith("image/jpeg") ? null : `type ${t || "inconnu"} (JPEG exigé par Instagram)`;
  } catch (e) { return "inaccessible : " + e.message; }
}

export async function generatePost(env, tenantId, { manual = false } = {}) {
  const day = manual ? `${utcDay()}T${new Date().toISOString().slice(11, 19)}` : utcDay();
  const exists = await env.DB.prepare("SELECT 1 FROM posts WHERE tenant_id=? AND day=?").bind(tenantId, day).first();
  if (!manual && exists) { await log(env, "info", "generation_ignoree", "post du jour déjà existant", tenantId); return null; }

  const svc = await pickService(env, tenantId, Math.floor(Date.now() / 864e5));
  const imgErr = await checkFile(env, svc.file);
  if (imgErr) throw new Error(`affiche ${svc.file} inaccessible : ${imgErr}`);
  const origin = env.IMAGE_BASE || (await env.DB.prepare("SELECT v FROM meta WHERE k='origin'").first())?.v;
  if (!origin) throw new Error("adresse publique inconnue : ouvrez une fois le tableau de bord");
  const imageUrl = `${origin.replace(/\/$/, "")}/affiches/${svc.file}`;

  const mode = getMode(env, Object.fromEntries((await env.DB.prepare("SELECT k,v FROM meta").all()).results.map(r => [r.k, r.v])));
  const settings = { site_url: env.SITE_URL };
  const phones = JSON.parse((await env.DB.prepare("SELECT v FROM meta WHERE k='contact_phones'").first())?.v || "null") || [PHONE_DEFAULT];
  const recent = await recentPosts(env, tenantId);

  let text = "", generator = "ai", provider = null;
  for (let t = 1; t <= 3 && !text; t++) {
    const r = await runAI(env, "write_post", { messages: [
      { role: "system", content: "Tu es community manager de Rising Digital Solutions (Agbelouvé, Togo), prestataire polyvalent de solutions, services, création et formation numériques. Écris en français simple, ton professionnel et chaleureux. INTERDIT : inventer clients, témoignages, prix, statistiques, promesses ; aucun chiffre, aucun lien, aucun numéro. Format : 50 à 90 mots, une accroche, 3 émojis maximum, puis 4 hashtags. Réponds uniquement avec le texte du post." },
      { role: "user", content: `Objectif : ${PILLARS[Math.floor(Date.now() / 864e5) % PILLARS.length]}. Service : ${svc.title}. Description officielle : ${svc.desc}` }] });
    const c = String(r.text || "").trim().replace(/^["«]|["»]$/g, "");
    if (r.ok && c.length >= 40 && c.length <= 1400 && !BAD.test(c) && !tooSimilar(c, recent)) { text = c; generator = "ai"; provider = r.provider; }
    else if (r.ok) await log(env, "warn", "texte_ia_rejete", `essai ${t} : ${c.length} car. ${r.ok && tooSimilar(c, recent) ? "(trop similaire jaccard=" + Math.max(...recent.map(x => jaccard(c, x)), 0).toFixed(2) + ")" : ""}`, tenantId);
  }
  if (!text) { // repli gratuit : gabarit déterministe, HONNÊTEMENT étiqueté
    const tpl = templatePost(svc, Math.floor(Date.now() / 864e5), phones[0], settings.site_url);
    text = tpl.text; generator = tpl.generator;
    await log(env, "warn", "repli_gabarit", "IA indisponible ou quota atteint : texte gabarit utilisé", tenantId);
  }
  const full = `${text}\n\nÉcrivez-nous sur WhatsApp : ${phones[0]}\n${settings.site_url}`;
  const status = mode === "auto" ? "approved" : mode === "approval" ? "pending" : "draft";

  const r = await env.DB.prepare("INSERT INTO posts(tenant_id,day,title,text,image,status,generator,updated_at) VALUES(?,?,?,?,?,?,?,?)")
    .bind(tenantId, day, svc.title, full, imageUrl, status, generator, nowISO()).run();
  const postId = r.meta.last_row_id;
  await markServiceUsed(env, tenantId, svc.id);
  await env.DB.prepare("INSERT OR IGNORE INTO media(tenant_id,kind,title,file,url,status) VALUES(?,?,?,?,?,?)")
    .bind(tenantId, "affiche", svc.title, svc.file, imageUrl, "ready").run();
  await log(env, "info", "post_genere", `#${postId} service=${svc.title} statut=${status} moteur=${generator}${provider ? " via " + provider : ""}`, tenantId);

  // Canaux cibles : file d'attente si configuré, sinon état honnête « non configuré ».
  const chEn = { facebook: !!(env.FB_PAGE_ID && env.FB_PAGE_TOKEN), instagram: !!(env.IG_USER_ID && (env.IG_TOKEN || env.FB_PAGE_TOKEN)), tiktok: true };
  for (const ch of ["facebook", "instagram", "tiktok"])
    await env.DB.prepare("INSERT OR IGNORE INTO post_channels(post_id,channel,status) VALUES(?,?,?)")
      .bind(postId, ch, chEn[ch] ? "queued" : "unconfigured").run();
  return postId;
}
