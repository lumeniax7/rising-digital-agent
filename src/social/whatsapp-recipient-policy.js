// Blocage permanent côté code : il reste actif même si la ligne D1 est supprimée ou inaccessible.
const PERMANENT_AUTOMATIC_BLOCKS = new Set(["22893333333"]);

export function normalizeWhatsAppRecipient(value) {
  const digits = String(value ?? "").replace(/\D/g, "");
  return digits.startsWith("00") ? digits.slice(2) : digits;
}

export class WhatsAppRecipientPolicyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WhatsAppRecipientPolicyError";
    this.code = code;
  }
}

export async function isWhatsAppRecipientBlocked(env, value) {
  const phone = normalizeWhatsAppRecipient(value);
  if (!/^\d{5,20}$/.test(phone)) {
    throw new WhatsAppRecipientPolicyError("invalid_recipient", "Destinataire WhatsApp invalide");
  }
  if (PERMANENT_AUTOMATIC_BLOCKS.has(phone)) return true;
  if (!env?.DB?.prepare) {
    throw new WhatsAppRecipientPolicyError("recipient_policy_unavailable", "Politique de blocage WhatsApp indisponible");
  }
  try {
    const row = await env.DB.prepare("SELECT phone_normalized FROM wa_recipient_blocks WHERE phone_normalized=?")
      .bind(phone).first();
    return Boolean(row);
  } catch {
    // Refus fermé : si la liste de blocage n’est pas consultable, aucun envoi ne doit continuer.
    throw new WhatsAppRecipientPolicyError("recipient_policy_unavailable", "Politique de blocage WhatsApp indisponible");
  }
}

export async function assertWhatsAppRecipientAllowed(env, value) {
  if (await isWhatsAppRecipientBlocked(env, value)) {
    throw new WhatsAppRecipientPolicyError("recipient_blocked", "Destinataire WhatsApp bloqué");
  }
}
