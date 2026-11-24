import { sendApprovedWhatsAppTemplate, renderReopenTemplateBody, WhatsAppTemplateBlockedError } from "./whatsapp-templates.js";
import { isWhatsAppRecipientBlocked, normalizeWhatsAppRecipient, WhatsAppRecipientPolicyError } from "./whatsapp-recipient-policy.js";
import { log } from "../core/log.js";

const CLAIM_LEASE_MS = 10 * 60_000;

async function updateQueue(env, sourceWamid, status, code, externalId = null) {
  await env.DB.prepare(`UPDATE wa_template_queue
    SET status=?, last_error=?, external_id=COALESCE(?,external_id), claimed_at=NULL, updated_at=?
    WHERE source_wamid=? AND status='processing'`)
    .bind(status, code, externalId, new Date().toISOString(), sourceWamid).run();
}

async function skip(env, item, code) {
  await updateQueue(env, item.source_wamid, "skipped", code);
  await log(env, "warn", "wa_template_non_envoye", code, item.tenant_id).catch(() => {});
}

/**
 * Dispatch only when an explicit non-secret feature flag is enabled. Every send
 * performs a fresh Meta status lookup; any unknown/review state leaves the row
 * waiting. Stale `processing` rows are never resent automatically because the
 * previous API call may have succeeded before a crash.
 */
export async function processWhatsAppTemplateQueue(env, limit = 20) {
  if (env.WA_TEMPLATE_SEND_ENABLED !== "true") return { disabled: true, claimed: 0, sent: 0, waiting: 0, failed: 0, skipped: 0 };
  const batchSize = Math.max(1, Math.min(20, Math.floor(Number(limit) || 20)));
  const now = new Date();
  const stale = new Date(now.getTime() - CLAIM_LEASE_MS).toISOString();
  const staleRows = await env.DB.prepare(`SELECT source_wamid,tenant_id FROM wa_template_queue
    WHERE status='processing' AND claimed_at<=? LIMIT ?`).bind(stale, batchSize).all();
  for (const item of staleRows.results || []) {
    await updateQueue(env, item.source_wamid, "failed", "ambiguous_previous_attempt");
    await log(env, "error", "wa_template_reprise_manuel", "résultat d’envoi antérieur ambigu; aucun renvoi automatique", item.tenant_id).catch(() => {});
  }

  const due = await env.DB.prepare(`SELECT source_wamid,tenant_id FROM wa_template_queue
    WHERE status='waiting_approval' ORDER BY created_at LIMIT ?`).bind(batchSize).all();
  const result = { disabled: false, claimed: 0, sent: 0, waiting: 0, failed: 0, skipped: 0 };
  for (const item of due.results || []) {
    const nowIso = new Date().toISOString();
    const claim = await env.DB.prepare(`UPDATE wa_template_queue
      SET status='processing', attempts=attempts+1, claimed_at=?, updated_at=?
      WHERE source_wamid=? AND status='waiting_approval'`).bind(nowIso, nowIso, item.source_wamid).run();
    if (!claim.meta?.changes) continue;
    result.claimed++;

    let source;
    try {
      source = await env.DB.prepare(`SELECT i.sender,i.payload,c.id AS contact_id,c.name,c.consent,
          cv.id AS conversation_id,cv.handoff,
          (SELECT m.external_id FROM messages m WHERE m.conversation_id=cv.id AND m.direction='in' ORDER BY m.id DESC LIMIT 1) AS latest_inbound
        FROM wa_inbox i LEFT JOIN contacts c
          ON c.tenant_id=i.tenant_id AND c.channel='whatsapp' AND c.external_id=i.sender
        LEFT JOIN conversations cv ON cv.id=(SELECT c2.id FROM conversations c2
          WHERE c2.tenant_id=i.tenant_id AND c2.channel='whatsapp' AND c2.contact_id=c.id ORDER BY c2.id DESC LIMIT 1)
        WHERE i.wamid=?`).bind(item.source_wamid).first();
      if (!source?.sender) {
        await skip(env, item, "source_missing"); result.skipped++; continue;
      }
      if (await isWhatsAppRecipientBlocked(env, source.sender)) {
        await skip(env, item, "recipient_blocked"); result.skipped++; continue;
      }
      const optOut = await env.DB.prepare("SELECT 1 AS found FROM wa_automation_optouts WHERE tenant_id=? AND phone_normalized=?")
        .bind(item.tenant_id, normalizeWhatsAppRecipient(source.sender)).first();
      if (optOut) {
        await skip(env, item, "customer_automation_opt_out"); result.skipped++; continue;
      }
      if (!source.conversation_id || Number(source.handoff) === 1) {
        await skip(env, item, "human_handoff_active_or_conversation_missing"); result.skipped++; continue;
      }
      if (source.latest_inbound !== item.source_wamid) {
        await skip(env, item, "superseded_by_newer_customer_message"); result.skipped++; continue;
      }
      if (Number(source.consent) !== 1) {
        await skip(env, item, "consent_not_recorded"); result.skipped++; continue;
      }
      let payload = {};
      try { payload = JSON.parse(source.payload || "{}"); } catch { /* absent profile falls back to CRM name */ }
      const customerName = String(source.name || payload._profile_name || "").trim();
      if (!customerName) {
        await skip(env, item, "customer_name_missing"); result.skipped++; continue;
      }
      const lead = source.contact_id
        ? await env.DB.prepare("SELECT service FROM leads WHERE tenant_id=? AND contact_id=? ORDER BY id DESC LIMIT 1").bind(item.tenant_id, source.contact_id).first()
        : null;
      const subject = String(lead?.service || "votre demande d’assistance").slice(0, 160);
      const fresh = await env.DB.prepare(`SELECT cv.handoff,
          (SELECT m.external_id FROM messages m WHERE m.conversation_id=cv.id AND m.direction='in' ORDER BY m.id DESC LIMIT 1) AS latest_inbound
        FROM conversations cv WHERE cv.id=?`).bind(source.conversation_id).first();
      if (!fresh || Number(fresh.handoff) === 1) {
        await skip(env, item, "human_handoff_active_or_conversation_missing"); result.skipped++; continue;
      }
      const finalOptOut = await env.DB.prepare("SELECT 1 AS found FROM wa_automation_optouts WHERE tenant_id=? AND phone_normalized=?")
        .bind(item.tenant_id, normalizeWhatsAppRecipient(source.sender)).first();
      if (finalOptOut) {
        await skip(env, item, "customer_automation_opt_out"); result.skipped++; continue;
      }
      if (fresh.latest_inbound !== item.source_wamid) {
        await skip(env, item, "superseded_by_newer_customer_message"); result.skipped++; continue;
      }
      const response = await sendApprovedWhatsAppTemplate(env, source.sender, customerName, subject);
      const externalId = response?.messages?.[0]?.id;
      if (typeof externalId !== "string" || !externalId) {
        await updateQueue(env, item.source_wamid, "failed", "response_without_message_id");
        result.failed++; continue;
      }

      const sentAt = new Date().toISOString();
      const statements = [];
      if (source.conversation_id) statements.push(env.DB.prepare(`INSERT OR IGNORE INTO messages
        (tenant_id,conversation_id,direction,external_id,body,ts) VALUES(?,?, 'out',?,?,?)`)
        .bind(item.tenant_id, source.conversation_id, externalId, renderReopenTemplateBody(customerName, subject), sentAt));
      statements.push(env.DB.prepare("UPDATE wa_template_queue SET status='sent',last_error=NULL,external_id=?,claimed_at=NULL,updated_at=? WHERE source_wamid=? AND status='processing'")
        .bind(externalId, sentAt, item.source_wamid));
      statements.push(env.DB.prepare("UPDATE wa_inbox SET reply_external_id=COALESCE(reply_external_id,?),updated_at=? WHERE wamid=?")
        .bind(externalId, sentAt, item.source_wamid));
      await env.DB.batch(statements);
      await log(env, "info", "wa_template_api_accepte", "modèle approuvé accepté par l’API; livraison non confirmée", item.tenant_id).catch(() => {});
      result.sent++;
    } catch (error) {
      if (error instanceof WhatsAppRecipientPolicyError) {
        if (error.code === "recipient_blocked") {
          await updateQueue(env, item.source_wamid, "skipped", "recipient_blocked");
          result.skipped++;
        } else {
          await env.DB.prepare(`UPDATE wa_template_queue
            SET status='waiting_approval', attempts=MAX(0,attempts-1), last_error=?, claimed_at=NULL, updated_at=?
            WHERE source_wamid=? AND status='processing'`)
            .bind(error.code, new Date().toISOString(), item.source_wamid).run();
          result.waiting++;
          break;
        }
      } else if (error instanceof WhatsAppTemplateBlockedError) {
        await env.DB.prepare(`UPDATE wa_template_queue
          SET status='waiting_approval', attempts=MAX(0,attempts-1), last_error=?, claimed_at=NULL, updated_at=?
          WHERE source_wamid=? AND status='processing'`)
          .bind(error.code, new Date().toISOString(), item.source_wamid).run();
        result.waiting++;
        if (error.code === "template_not_approved" || error.code === "template_status_unavailable" || error.code === "template_disabled" || error.code === "missing_waba_id") break;
        continue;
      }
      // Un transport/API error après tentative d’envoi est ambigu; éviter un doublon automatique.
      await updateQueue(env, item.source_wamid, "failed", "send_result_ambiguous_or_rejected");
      await log(env, "error", "wa_template_echec_revue", "échec d’envoi; revue manuelle requise avant tout nouvel essai", item.tenant_id).catch(() => {});
      result.failed++;
    }
  }
  return result;
}
