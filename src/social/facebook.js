import { graph } from "./meta.js";

export async function publishPhoto(env, post, settings) {
  const j = await graph(env, "POST", `/${env.FB_PAGE_ID}/photos`, { url: post.image, message: post.text }, env.FB_PAGE_TOKEN);
  const id = j.post_id || j.id;
  if (!id) throw new Error("réponse Facebook sans identifiant");
  return String(id);
}

// Réconciliation : avant de réessayer, vérifier si la publication existe déjà (évite les doublons).
export async function reconcile(env, post, settings) {
  try {
    const j = await graph(env, "GET", `/${env.FB_PAGE_ID}/posts?limit=10&fields=id,message`, null, env.FB_PAGE_TOKEN);
    const needle = post.text.slice(0, 60);
    const hit = (j.data || []).find(x => x.message && x.message.includes(needle));
    return hit ? String(hit.id) : null;
  } catch { return null; }
}
