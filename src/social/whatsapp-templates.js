import { graph } from "./meta.js";
import { assertWhatsAppRecipientAllowed } from "./whatsapp-recipient-policy.js";

export const REOPEN_TEMPLATE_NAME = "reprise_conversation_client";
export const REOPEN_TEMPLATE_LANGUAGE = "fr";
export const REOPEN_TEMPLATE_CATEGORY = "UTILITY";
export const REOPEN_TEMPLATE_BODY = "Bonjour {{1}},\n\nNous revenons vers vous concernant votre échange avec notre service.\n\nNous souhaitons savoir si vous avez toujours besoin de notre assistance concernant : {{2}}.\n\nRépondez simplement à ce message afin que nous puissions poursuivre notre échange.\n\nMerci pour votre confiance.";

export function renderReopenTemplateBody(customerName, subject) {
  return REOPEN_TEMPLATE_BODY.replace("{{1}}", customerName).replace("{{2}}", subject);
}

export class WhatsAppTemplateBlockedError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WhatsAppTemplateBlockedError";
    this.code = code;
  }
}

function nonEmptyText(value, label, max = 240) {
  if (typeof value !== "string") throw new WhatsAppTemplateBlockedError("invalid_parameters", `${label} manquant`);
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
  if (!cleaned) throw new WhatsAppTemplateBlockedError("invalid_parameters", `${label} manquant`);
  return cleaned;
}

function validateBody(template) {
  const bodies = (template.components || []).filter(component => String(component.type).toUpperCase() === "BODY");
  if (bodies.length !== 1 || typeof bodies[0].text !== "string") return false;
  const placeholders = [...bodies[0].text.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)].map(match => match[1].trim());
  const normalize = value => String(value).replace(/\s+/g, " ").trim();
  return placeholders.length === 2 && placeholders[0] === "1" && placeholders[1] === "2" &&
    normalize(bodies[0].text) === normalize(REOPEN_TEMPLATE_BODY);
}

async function readTemplate(env) {
  if (env.WA_TEMPLATE_SEND_ENABLED !== "true") {
    throw new WhatsAppTemplateBlockedError("template_disabled", "Envoi de modèles désactivé par configuration");
  }
  const wabaId = String(env.WA_WABA_ID || "").trim();
  if (!/^\d{5,30}$/.test(wabaId)) {
    throw new WhatsAppTemplateBlockedError("missing_waba_id", "Identifiant WABA absent ou invalide");
  }
  const token = typeof env.WA_TOKEN === "string" ? env.WA_TOKEN.trim() : "";
  if (!token) throw new WhatsAppTemplateBlockedError("missing_token", "Jeton WhatsApp non configuré");

  const matches = [];
  let after = "";
  let pages = 0;
  do {
    if (++pages > 20) throw new WhatsAppTemplateBlockedError("template_pagination_limit", "Lecture des modèles interrompue après 20 pages");
    const query = new URLSearchParams({
      fields: "name,status,language,category,components,parameter_format",
      limit: "100",
    });
    if (after) query.set("after", after);
    let result;
    try {
      result = await graph(env, "GET", `/${wabaId}/message_templates?${query.toString()}`, null, token);
    } catch {
      throw new WhatsAppTemplateBlockedError("template_status_unavailable", "Impossible de vérifier le statut du modèle auprès de Meta");
    }
    if (!Array.isArray(result?.data)) throw new WhatsAppTemplateBlockedError("invalid_template_response", "Réponse Meta des modèles invalide");
    matches.push(...result.data.filter(item => item?.name === REOPEN_TEMPLATE_NAME && item?.language === REOPEN_TEMPLATE_LANGUAGE));
    after = String(result?.paging?.cursors?.after || "");
    if (!result?.paging?.next || !after) break;
  } while (true);

  if (matches.length !== 1) {
    throw new WhatsAppTemplateBlockedError("template_not_unique", "Le modèle attendu est absent ou ambigu dans Meta");
  }
  const template = matches[0];
  if (template.status !== "APPROVED") {
    throw new WhatsAppTemplateBlockedError("template_not_approved", `Le modèle Meta n’est pas APPROVED (${String(template.status || "statut inconnu")})`);
  }
  if (template.category !== REOPEN_TEMPLATE_CATEGORY || !validateBody(template)) {
    throw new WhatsAppTemplateBlockedError("template_definition_mismatch", "Catégorie ou paramètres du modèle différents de la configuration attendue");
  }
  if (template.parameter_format && String(template.parameter_format).toUpperCase() !== "POSITIONAL") {
    throw new WhatsAppTemplateBlockedError("template_parameter_format_mismatch", "Le modèle Meta n’utilise pas des paramètres positionnels");
  }
  return template;
}

/**
 * Envoi volontairement protégé par un indicateur explicite, puis par une lecture
 * Meta fraîche avant chaque POST. Aucun envoi n’est permis en cas d’état inconnu.
 */
export async function sendApprovedWhatsAppTemplate(env, to, customerName, subject) {
  const recipient = String(to || "").replace(/^\+/, "");
  if (!/^\d{5,20}$/.test(recipient)) throw new WhatsAppTemplateBlockedError("invalid_recipient", "Destinataire WhatsApp invalide");
  await assertWhatsAppRecipientAllowed(env, recipient);
  const name = nonEmptyText(customerName, "Nom client");
  const topic = nonEmptyText(subject, "Sujet de la demande");
  const phoneId = String(env.WA_PHONE_ID || "").trim();
  if (!/^\d{5,30}$/.test(phoneId)) throw new WhatsAppTemplateBlockedError("missing_phone_id", "Identifiant du numéro WhatsApp absent ou invalide");

  await readTemplate(env);
  return graph(env, "POST", `/${phoneId}/messages`, {
    messaging_product: "whatsapp",
    to: recipient,
    type: "template",
    template: {
      name: REOPEN_TEMPLATE_NAME,
      language: { code: REOPEN_TEMPLATE_LANGUAGE },
      components: [{
        type: "body",
        parameters: [
          { type: "text", text: name },
          { type: "text", text: topic },
        ],
      }],
    },
  }, env.WA_TOKEN);
}
