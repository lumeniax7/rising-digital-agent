import { graph } from "./meta.js";

const sleep = ms => new Promise(r => setTimeout(r, ms));
const token = env => env.IG_TOKEN || env.FB_PAGE_TOKEN;

export async function publishImage(env, post, containerId) {
  const tok = token(env);
  let container = containerId;
  if (container) { // reprise : vérifier le conteneur existant au lieu d'un délai fixe
    const s = await graph(env, "GET", `/${container}?fields=status_code`, null, tok).catch(() => ({}));
    if (!["FINISHED", "IN_PROGRESS"].includes(s.status_code)) container = null;
  }
  if (!container) {
    container = (await graph(env, "POST", `/${env.IG_USER_ID}/media`, { image_url: post.image, caption: post.text.slice(0, 2200) }, tok)).id;
    if (!container) throw new Error("conteneur Instagram sans identifiant");
  }
  let st = "";
  for (let i = 0; i < 30; i++) { // interroger le STATUT réel, jamais un simple délai
    st = (await graph(env, "GET", `/${container}?fields=status_code`, null, tok)).status_code;
    if (st === "FINISHED") break;
    if (st === "ERROR" || st === "EXPIRED") throw new Error(`conteneur Instagram ${st}`);
    await sleep(3000);
  }
  if (st !== "FINISHED") throw new Error("Instagram encore en traitement après 90 s");
  const j = await graph(env, "POST", `/${env.IG_USER_ID}/media_publish`, { creation_id: container }, tok);
  if (!j.id) throw new Error("publication Instagram sans identifiant");
  return { id: String(j.id), container };
}

// Réconciliation avant nouvelle tentative : un conteneur FINISHED déjà publié ne doit pas repartir.
export async function reconcile(env, post, containerId) {
  if (!containerId) return null;
  const s = await graph(env, "GET", `/${containerId}?fields=status_code`, null, token(env)).catch(() => ({}));
  if (s.status_code === "FINISHED") {
    const j = await graph(env, "GET", `/${env.IG_USER_ID}/media?limit=10&fields=id,caption`, null, token(env)).catch(() => ({ data: [] }));
    const needle = post.text.slice(0, 40);
    const hit = (j.data || []).find(x => (x.caption || "").includes(needle));
    if (hit) return String(hit.id); // déjà publié réellement
  }
  return null;
}
