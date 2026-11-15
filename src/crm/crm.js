// CRM minimal : contacts, prospects (leads), consentement, relances autorisées uniquement.
import { nowISO } from "../core/util.js";

export async function upsertContact(env, tenantId, channel, externalId, name = null) {
  await env.DB.prepare("INSERT OR IGNORE INTO contacts(tenant_id,channel,external_id,name) VALUES(?,?,?,?)").bind(tenantId, channel, externalId, name).run();
  await env.DB.prepare("UPDATE contacts SET name=COALESCE(?, name), updated_at=? WHERE tenant_id=? AND channel=? AND external_id=?")
    .bind(name, nowISO(), tenantId, channel, externalId).run();
  return (await env.DB.prepare("SELECT id FROM contacts WHERE tenant_id=? AND channel=? AND external_id=?").bind(tenantId, channel, externalId).first()).id;
}

export async function upsertLead(env, tenantId, contactId, { service = null, need = null, urgency = null, status = "nouveau" } = {}) {
  const ex = (await env.DB.prepare("SELECT id,status FROM leads WHERE tenant_id=? AND contact_id=? AND status NOT IN ('gagné','perdu') ORDER BY id DESC LIMIT 1")
    .bind(tenantId, contactId).first());
  if (ex) {
    await env.DB.prepare("UPDATE leads SET service=COALESCE(?,service), need=COALESCE(?,need), urgency=COALESCE(?,urgency), updated_at=? WHERE id=?")
      .bind(service, need, urgency, nowISO(), ex.id).run();
    return ex.id;
  }
  const r = await env.DB.prepare("INSERT INTO leads(tenant_id,contact_id,service,need,urgency,status) VALUES(?,?,?,?,?,?)")
    .bind(tenantId, contactId, service, need, urgency, status).run();
  return r.meta.last_row_id;
}

// Mots-clés de qualification (heuristique simple, transparente — jamais de tarif inventé).
import { normWords } from "../core/util.js";
export function detectLeadSignal(text, services) {
  const t = String(text);
  const words = normWords(text);
  let service = null;
  for (const s of services) if ([...normWords(s.title)].some(w => words.has(w))) { service = s.title; break; }
  const urgency = /(urgent|aujourd'hui|rapidement|de ce pas|immédiat)/i.test(t) ? "haute" : null;
  return { service, urgency, hasNeed: t.length > 15 };
}
