import { test } from "node:test";
import assert from "node:assert/strict";
import { detectLeadSignal } from "../src/crm/crm.js";

const HANDOFF = /(litige|remboursement|plainte|réclamation|parler à (un|une) (humain|personne|agent)|responsable|contrat|paiement direct)/i;
test("détection de transfert humain", () => {
  for (const t of ["je veux un remboursement", "je voudrais parler à une personne", "c'est un litige !!", "quel est le contrat ?"])
    assert.ok(HANDOFF.test(t), t);
  assert.ok(!HANDOFF.test("bonjour, je voudrais un site web"));
});
test("qualification de prospect sans inventer de tarif", () => {
  const services = [{ title: "Création de site et application" }, { title: "Intelligence artificielle" }];
  const r = detectLeadSignal("bonjour je voudrais un site web pour ma boutique, c'est urgent", services);
  assert.equal(r.service, "Création de site et application");
  assert.equal(r.urgency, "haute");
  assert.ok(r.hasNeed);
});
test("message trop court ne crée pas de prospect", () => {
  const r = detectLeadSignal("salut", [{ title: "x" }]);
  assert.ok(!r.hasNeed);
});
test("parsing webhook : tous les messages extraits", () => {
  const data = { entry: [{ changes: [{ value: { messages: [{ id: "wamid.A", from: "22890000001" }, { id: "wamid.B", from: "22890000002" }] } }] },
    { changes: [{ value: { messages: [{ id: "wamid.C", from: "22890000003" }] } }] }] };
  const out = [];
  for (const e of data.entry || []) for (const c of e.changes || []) for (const m of c.value?.messages || []) if (m.id && m.from) out.push(m);
  assert.equal(out.length, 3); // le bug v3 (premier message seulement) est corrigé
});
