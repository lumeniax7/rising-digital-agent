// Orchestrateur de publication : états RÉELS par canal, réclamation atomique, réconciliation, backoff.
import { log } from "../core/log.js";
import { nowISO, backoffMs } from "../core/util.js";
import { derivePostStatus } from "../core/state.js";
import * as facebook from "./facebook.js";
import * as instagram from "./instagram.js";
import * as tiktok from "./tiktok.js";
const MAX_ATTEMPTS = 5;

// Le statut doit être explicitement fourni par l'appelant. L'absence de statut refuse
// par défaut, y compris pour les anciens appelants qui ne passent que trois arguments.
export async function publishChannel(env, post, pc, postStatus) {
  if (postStatus !== "approved") return { ok: false, reason: "post non approuvé" };
  if (Number(pc?.attempts || 0) >= MAX_ATTEMPTS) return { ok: false, reason: "limite de tentatives atteinte" };

  const claim = await env.DB.prepare(
    "UPDATE post_channels SET status='publishing', attempts=attempts+1, updated_at=? WHERE id=? AND status IN ('queued','error','pending') AND attempts<? AND (next_attempt_at IS NULL OR next_attempt_at<=?)")
    .bind(nowISO(), pc.id, MAX_ATTEMPTS, nowISO()).run();
  if (!claim.meta.changes) return { ok: false, reason: "canal déjà pris en charge ou non dû" }; // idempotence
  const onError = async (msg, status = "error") => {
    const retry = Number(pc.attempts || 0) + 1 < MAX_ATTEMPTS;
    await env.DB.prepare("UPDATE post_channels SET status=?, last_error=?, next_attempt_at=?, updated_at=? WHERE id=?")
      .bind(status, String(msg).slice(0, 500), retry ? new Date(Date.now() + backoffMs(Number(pc.attempts || 0))).toISOString() : null, nowISO(), pc.id).run();
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
  return { ok: true };
}

// Reprise des publications interrompues + traitement des canaux dus.
export async function publishDue(env, tenantId, limit = 3) {
  await env.DB.prepare("UPDATE post_channels SET status='error', last_error=COALESCE(last_error,'')||' | interrompu (délai dépassé)' WHERE status='publishing' AND updated_at<datetime('now','-15 minutes')").run();
  await rebaselineImageUrls(env, tenantId);
  // Les anciennes lignes ayant déjà consommé le plafond restent visibles comme erreurs terminales.
  await env.DB.prepare(`UPDATE post_channels SET status='error', next_attempt_at=NULL,
      last_error=CASE WHEN last_error IS NULL OR last_error='' THEN 'limite de tentatives atteinte' ELSE last_error||' | limite de tentatives atteinte' END,
      updated_at=? WHERE status IN ('queued','error') AND attempts>=? AND post_id IN
      (SELECT id FROM posts WHERE tenant_id=? AND status='approved')
      AND (last_error IS NULL OR last_error NOT LIKE '%limite de tentatives atteinte%')`)
    .bind(nowISO(), MAX_ATTEMPTS, tenantId).run();
  const due = (await env.DB.prepare(
    `SELECT pc.*, p.text, p.image, p.title, p.status AS post_status FROM post_channels pc JOIN posts p ON p.id=pc.post_id
     WHERE pc.status IN ('queued','error') AND pc.attempts<? AND (pc.next_attempt_at IS NULL OR pc.next_attempt_at<=?)
       AND p.tenant_id=? AND p.status='approved'
     ORDER BY pc.id LIMIT ?`).bind(MAX_ATTEMPTS, nowISO(), tenantId, limit).all()).results;
  for (const pc of due) await publishChannel(env, { id: pc.post_id, text: pc.text, image: pc.image, title: pc.title }, pc, pc.post_status);
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
    "SELECT post_id, status, attempts FROM post_channels WHERE post_id IN (SELECT id FROM posts WHERE tenant_id=?)").bind(tenantId).all()).results;
  const approved = new Set((await env.DB.prepare("SELECT id FROM posts WHERE tenant_id=? AND status='approved'").bind(tenantId).all()).results.map(r => String(r.id)));
  const byPost = {};
  for (const r of rows) (byPost[r.post_id] ??= []).push(r);
  for (const [pid, chs] of Object.entries(byPost)) {
    // L'approbation reste l'autorisation de publier tant qu'un canal a encore une
    // tentative permise; sinon un premier échec retirerait les retries de la file.
    if (approved.has(String(pid)) && chs.some(c => ["queued", "error", "pending", "publishing"].includes(c.status) && Number(c.attempts || 0) < MAX_ATTEMPTS)) continue;
    const s = derivePostStatus(chs);
    await env.DB.prepare("UPDATE posts SET status=?, updated_at=? WHERE id=? AND status NOT IN ('draft','pending','rejected')").bind(s, nowISO(), pid).run();
  }
}
