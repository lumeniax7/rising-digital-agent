// Générateur de publications : IA avec contrôles + repli gabarit éloquent (honnête, jamais faux).
import { log } from "../core/log.js";
import { runAI } from "../ai/router.js";
import { utcDay, nowISO, jaccard } from "../core/util.js";
import { getMode } from "../core/config.js";
import { PILLARS, pickService, markServiceUsed, recentPosts, tooSimilar } from "./editorial.js";

const PHONE_DEFAULT = "+228 93 39 25 15";
const BAD = /(\d|fcfa|cfa|€|\$|garanti|témoignage|satisfait|http|www\.)/i;

// Gabarit de repli ÉLOQUENT : storytelling, bénéfices concrets, appel à l'action.
// Aucun chiffre, aucun prix, aucune promesse — juste du style.
export function templatePost(svc, pillarIdx, phone, siteUrl) {
  const descr = String(svc.descr || svc.desc || svc.title);
  const d = descr.charAt(0).toLowerCase() + descr.slice(1);
  const pillars = [
    `💡 Le numérique, c'est comme un atelier : on avance outil par outil, et chaque outil bien maîtrisé change un quotidien.\n\n✨ Aujourd'hui, parlons de ${svc.title.toLowerCase()} — ${d}\n\nQue vous soyez entrepreneur, commerçant, ONG ou église, il y a toujours une façon plus simple, plus claire et plus professionnelle de faire les choses.`,
    `🚀 Et si votre activité donnait enfin l'image qu'elle mérite ?\n\n${svc.title} : ${d}\n\nUne image claire attire la confiance. La confiance attire les clients. Et les clients, c'est ce qui fait vivre un projet.`,
    `👤 Derrière chaque entreprise qui grandit, il y a des outils qui marchent et des messages qui touchent.\n\n✨ ${svc.title}, c'est ${d}\n\nNotre façon de travailler : on écoute d'abord votre réalité, on propose ensuite une solution simple, et on vous accompagne jusqu'à ce que ça marche pour vous.`,
    `💬 Un projet en tête ? Parlons-en simplement.\n\n✨ ${svc.title} — ${d}\n\nChez Rising Digital Solutions, pas de jargon ni de discours compliqué : on étudie votre besoin, on vous montre ce qui est possible, et le devis ne vient que lorsque tout est clair pour vous.`
  ];
  const hashtags = "#RisingDigital #Togo #Numérique #Entrepreneuriat";
  const body = `${pillars[pillarIdx % 4]}\n\n${hashtags}`;
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

const SYSTEM_PROMPT = `Tu es rédacteur publicitaire senior pour Rising Digital Solutions, agence polyvalente de solutions numériques à Agbelouvé (Togo) : création graphique, sites web et applications, IA, formation, maintenance informatique, photographie, sérigraphie, e-commerce, accompagnement des entrepreneurs, ONG et églises.

Écris un post Facebook QUI ACCROCHE, en français :
1. OUVRE avec une phrase qui parle de la réalité vécue (entrepreneur qui débute, boutique qui veut vendre plus, association qui veut se faire connaître) — pas de "Bonjour" ni de "Nous vous proposons".
2. RAconte le problème en une phrase vivante.
3. MONTRE ce que le service apporte concrètement, avec des bénéfices tangibles (visibilité, crédibilité, temps gagné, clients touchés).
4. TERMINE par une invitation chaleureuse à écrire sur WhatsApp pour en discuter (pas de pression, pas de devis imposé).

Style : humain, chaleureux, inspirant, imagé ; phrases courtes qui respirent. Longueur : 80 à 120 mots. 4 émojis maximum, placés naturellement. Termine par 4 hashtags pertinents (dont #RisingDigital et #Togo).

INTERDIT ABSOLU : chiffres, prix, pourcentages, liens, promesses de résultats garantis, témoignages ou clients inventés, mots anglais inutiles. Réponds UNIQUEMENT avec le texte du post, sans introduction ni commentaire.`;

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

  const meta = Object.fromEntries((await env.DB.prepare("SELECT k,v FROM meta").all()).results.map(r => [r.k, r.v]));
  const mode = getMode(env, meta);
  const settings = { site_url: meta.site_url || env.SITE_URL };
  const phones = JSON.parse((await env.DB.prepare("SELECT v FROM meta WHERE k='contact_phones'").first())?.v || "null") || [PHONE_DEFAULT];
  const recent = await recentPosts(env, tenantId);

  let text = "", generator = "ai", provider = null;
  const failed = []; // fournisseurs déjà essayés : les tentatives suivantes passent au suivant
  for (let t = 1; t <= 3 && !text; t++) {
    const r = await runAI(env, "write_post", { messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `Objectif éditorial du jour : ${PILLARS[Math.floor(Date.now() / 864e5) % PILLARS.length]}. Service à mettre en avant : ${svc.title}. Description officielle (à respecter, ne rien inventer au-delà) : ${svc.descr || svc.desc || ""}` }],
      skip: failed });
    const c = String(r.text || "").trim().replace(/^["«]|["»]$/g, "");
    if (r.ok && c.length >= 40 && c.length <= 1400 && !BAD.test(c) && !tooSimilar(c, recent)) { text = c; generator = "ai"; provider = r.provider; }
    else {
      if (!r.ok) { failed.push(r.provider); if (t === 1 || failed.length === 1) await log(env, "warn", "ia_echec", `fournisseur ${r.provider} : ${r.reason}`, tenantId); }
      else if (r.ok) await log(env, "warn", "texte_ia_rejete", `essai ${t} : ${c.length} car.${tooSimilar(c, recent) ? " (trop similaire)" : ""}`, tenantId);
    }
  }
  if (!text) { // repli gratuit : gabarit éloquent, HONNÊTEMENT étiqueté
    const tpl = templatePost(svc, Math.floor(Date.now() / 864e5), phones[0], settings.site_url);
    text = tpl.text; generator = tpl.generator;
    await log(env, "warn", "repli_gabarit", "IA indisponible ou quota atteint : texte gabarit (éloquent) utilisé", tenantId);
  }
  const full = `${text}\n\n📱 Écrivez-nous sur WhatsApp : ${phones[0]}\n🌐 ${settings.site_url}`;
  const status = mode === "auto" ? "approved" : mode === "approval" ? "pending" : "draft";

  const r = await env.DB.prepare("INSERT INTO posts(tenant_id,day,title,text,image,status,generator,updated_at) VALUES(?,?,?,?,?,?,?,?)")
    .bind(tenantId, day, svc.title, full, imageUrl, status, generator, nowISO()).run();
  const postId = r.meta.last_row_id;
  await markServiceUsed(env, tenantId, svc.id);
  await env.DB.prepare("INSERT OR IGNORE INTO media(tenant_id,kind,title,file,url,status) VALUES(?,?,?,?,?,?)")
    .bind(tenantId, "affiche", svc.title, svc.file, imageUrl, "ready").run();
  await log(env, "info", "post_genere", `#${postId} service=${svc.title} statut=${status} moteur=${generator}${provider ? " via " + provider : ""}`, tenantId);

  const chEn = { facebook: !!(env.FB_PAGE_ID && env.FB_PAGE_TOKEN), instagram: !!(env.IG_USER_ID && (env.IG_TOKEN || env.FB_PAGE_TOKEN)), tiktok: true };
  for (const ch of ["facebook", "instagram", "tiktok"])
    await env.DB.prepare("INSERT OR IGNORE INTO post_channels(post_id,channel,status) VALUES(?,?,?)")
      .bind(postId, ch, chEn[ch] ? "queued" : "unconfigured").run();
  return postId;
}
