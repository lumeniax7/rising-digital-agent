// Orchestrateur de publication : états RÉELS par canal, réclamation atomique, réconciliation, backoff.
import { log } from "../core/log.js";
import { nowISO, backoffMs } from "../core/util.js";
import { derivePostStatus } from "../core/state.js";
import * as facebook from "./facebook.js";
import * as instagram from "./instagram.js";
import * as tiktok from "./tiktok.js";

const MAX_ATTEMPTS = 5;

export async function publishChannel(env, post, pc) {
  const claim = await env.DB.prepare(
    "UPDATE post_channels SET status='publishing', attempts=attempts+1, updated_at=? WHERE id=? AND status IN ('queued','error','pending') AND (next_attempt_at IS NULL OR next_attempt_at<=?)")
    .bind(nowISO(), pc.id, nowISO()).run();
  if (!claim.meta.changes) return; // déjà pris en charge (idempotence)
  const onError = async (msg, status = "error") => {
    const retry = pc.attempts + 1 < MAX_ATTEMPTS;
    await env.DB.prepare("UPDATE post_channels SET status=?, last_error=?, next_attempt_at=?, updated_at=? WHERE id=?")
      .bind(status, String(msg).slice(0, 500), retry ? new Date(Date.now() + backoffMs(pc.attempts)).toISOString() : null, nowISO(), pc.id).run();
    await log(env, "error", `publication_${pc.channel}_${status}`, `post #${post.id} : ${msg}`);
  };
  try {
    if (pc.channel === "facebook") {
      if (!(env.FB_PAGE_ID && env.FB_PAGE_TOKEN)) return void await onError("non configuré (FB_PAGE_ID / FB_PAGE_TOKEN manquants)", "unconfigured");
      if (pc.attempts > 0) { // réconciliation : la plateforme a-t-elle déjà créé la publication ?
        const found = await facebook.reconcile(env, post, {}).catch(() => null);
        if (found) return void await env.DB.prepare("UPDATE post_channels SET status='published', external_id=?, updated_at=? WHERE id=?").bind(found, nowISO(), pc.id).run();
      }
      const id = await facebook.publishPhoto(env, post, {});
      await env.DB.prepare("UPDATE post_channels SET status='published', external_id=?, updated_at=? WHERE id=?").bind(id, nowISO(), pc.id).run();
    } else if (pc.channel === "instagram") {
      const tok = env.IG_TOKEN || env.FB_PAGE_TOKEN;
      if (!(env.IG_USER_ID && tok)) return void await onError("non configuré (IG_USER_ID / jeton manquants)", "unconfigured");
      if (pc.attempts > 0) {
        const found = await instagram.reconcile(env, post, pc.container_id).catch(() => null);
        if (found) return void await env.DB.prepare("UPDATE post_channels SET status='published', external_id=?, updated_at=? WHERE id=?").bind(found, nowISO(), pc.id).run();
      }
      const r = await instagram.publishImage(env, post, pc.container_id);
      await env.DB.prepare("UPDATE post_channels SET status='published', external_id=?, container_id=?, updated_at=? WHERE id=?").bind(r.id, r.container, nowISO(), pc.id).run();
    } else if (pc.channel === "tiktok") {
      const d = await tiktok.prepareDraft(env, post, {});
      await env.DB.prepare("UPDATE post_channels SET status=?, external_id=NULL, last_error=?, updated_at=? WHERE id=?")
        .bind(d.status, "API Content Posting non approuvée : export manuel", nowISO(), pc.id).run();
      await log(env, "info", "tiktok_export_manuel", `post #${post.id} : paquet prêt à publier`);
    } else return void await onError(`canal inconnu : ${pc.channel}`);
  } catch (e) { await onError(e.message); }
}

// Reprise des publications interrompues + traitement des canaux dus.
export async function publishDue(env, tenantId, limit = 3) {
  await env.DB.prepare("UPDATE post_channels SET status='error', last_error=COALESCE(last_error,'')||' | interrompu (délai dépassé)' WHERE status='publishing' AND updated_at<datetime('now','-15 minutes')").run();
  await rebaselineImageUrls(env, tenantId);
  const due = (await env.DB.prepare(
    `SELECT pc.*, p.text, p.image, p.title FROM post_channels pc JOIN posts p ON p.id=pc.post_id
     WHERE pc.status IN ('queued','error') AND (pc.next_attempt_at IS NULL OR pc.next_attempt_at<=?) AND p.tenant_id=?
     ORDER BY pc.id LIMIT ?`).bind(nowISO(), tenantId, limit).all()).results;
  for (const pc of due) await publishChannel(env, { id: pc.post_id, text: pc.text, image: pc.image, title: pc.title }, pc);
  await refreshPostStatuses(env, tenantId);
}

// Reconstruit l'URL d'image de chaque post à partir de l'origine courante (protège contre
// un enregistrement d'origine erroné, ex. préfixe workers.dev d'aperçu).
async function rebaselineImageUrls(env, tenantId) {
  const origin = env.IMAGE_BASE || (await env.DB.prepare("SELECT v FROM meta WHERE k='origin'").first())?.v;
  if (!origin) return;
  const rows = (await env.DB.prepare("SELECT id, image FROM posts WHERE tenant_id=?").bind(tenantId).all()).results;
  for (const r of rows) {
    const file = String(r.image || "").split("/affiches/")[1];
    if (file) {
      const want = `${origin.replace(/\/$/, "")}/affiches/${file}`;
      if (want !== r.image) await env.DB.prepare("UPDATE posts SET image=? WHERE id=?").bind(want, r.id).run();
    }
  }
}

// Recalcule le statut GLOBAL de chaque post à partir de ses canaux (succès partiel ≠ succès complet).
export async function refreshPostStatuses(env, tenantId) {
  const rows = (await env.DB.prepare(
    "SELECT post_id, status FROM post_channels WHERE post_id IN (SELECT id FROM posts WHERE tenant_id=?)").bind(tenantId).all()).results;
  const byPost = {};
  for (const r of rows) (byPost[r.post_id] ??= []).push(r);
  for (const [pid, chs] of Object.entries(byPost)) {
    const s = derivePostStatus(chs);
    await env.DB.prepare("UPDATE posts SET status=?, updated_at=? WHERE id=? AND status NOT IN ('draft','pending','rejected')").bind(s, nowISO(), pid).run();
  }
}
