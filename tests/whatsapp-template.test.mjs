import { test } from "node:test";
import assert from "node:assert/strict";
import { sendApprovedWhatsAppTemplate, REOPEN_TEMPLATE_BODY } from "../src/social/whatsapp-templates.js";
import { processWhatsAppTemplateQueue } from "../src/social/whatsapp-template-queue.js";

const TOKEN = "test-whatsapp-token";
const goodTemplate = status => ({
  name: "reprise_conversation_client",
  language: "fr",
  category: "UTILITY",
  status,
  parameter_format: "POSITIONAL",
  components: [{ type: "BODY", text: REOPEN_TEMPLATE_BODY }],
});
const env = ({ blocked = [] } = {}) => ({
  WA_TEMPLATE_SEND_ENABLED: "true",
  WA_WABA_ID: "12345678901",
  WA_PHONE_ID: "10987654321",
  WA_TOKEN: TOKEN,
  GRAPH_VERSION: "v23.0",
  DB: { prepare() { return { bind(phone) { return { first: async () => blocked.includes(phone) ? { phone_normalized: phone } : null }; } }; } },
});

async function withFetch(handler, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  try { return await fn(); }
  finally { globalThis.fetch = original; }
}

test("destinataire bloqué: aucun GET de statut ni POST de modèle", async () => {
  let calls = 0;
  await withFetch(async () => { calls++; throw new Error("aucun appel Meta ne doit être fait"); }, async () => {
    await assert.rejects(() => sendApprovedWhatsAppTemplate(env({ blocked: ["22893333333"] }), "0022893333333", "Ama", "Demande"),
      error => error.code === "recipient_blocked");
  });
  assert.equal(calls, 0);
});

test("modèle approuvé: lecture du statut puis payload Meta exact en positionnel", async () => {
  const calls = [];
  await withFetch(async (url, options) => {
    calls.push({ url: String(url), options });
    if (options.method === "GET") return new Response(JSON.stringify({ data: [goodTemplate("APPROVED")] }), { status: 200 });
    return new Response(JSON.stringify({ messages: [{ id: "wamid.TEMPLATE_1" }] }), { status: 200 });
  }, async () => {
    const result = await sendApprovedWhatsAppTemplate(env(), "+22890681092", "Ama", "Création de site");
    assert.equal(result.messages[0].id, "wamid.TEMPLATE_1");
  });
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/12345678901\/message_templates\?/);
  assert.match(calls[0].url, /fields=name%2Cstatus%2Clanguage%2Ccategory%2Ccomponents%2Cparameter_format/);
  assert.equal(calls[0].options.headers.authorization, `Bearer ${TOKEN}`);
  assert.doesNotMatch(calls[0].url, new RegExp(TOKEN));
  const sent = JSON.parse(calls[1].options.body);
  assert.equal(sent.type, "template");
  assert.equal(sent.template.name, "reprise_conversation_client");
  assert.deepEqual(sent.template.language, { code: "fr" });
  assert.deepEqual(sent.template.components[0].parameters, [
    { type: "text", text: "Ama" },
    { type: "text", text: "Création de site" },
  ]);
});

test("statut PENDING n’émet aucun POST de message", async () => {
  let posts = 0;
  await withFetch(async (_url, options) => {
    if (options.method === "POST") posts++;
    return new Response(JSON.stringify({ data: [goodTemplate("PENDING")] }), { status: 200 });
  }, async () => {
    await assert.rejects(() => sendApprovedWhatsAppTemplate(env(), "22890681092", "Ama", "Demande"), error => error.code === "template_not_approved");
  });
  assert.equal(posts, 0);
});

test("définition ou paramètres non conformes bloquent l’envoi", async () => {
  let posts = 0;
  await withFetch(async (_url, options) => {
    if (options.method === "POST") posts++;
    const template = { ...goodTemplate("APPROVED"), components: [{ type: "BODY", text: "Bonjour {{1}}, sujet {{3}}" }] };
    return new Response(JSON.stringify({ data: [template] }), { status: 200 });
  }, async () => {
    await assert.rejects(() => sendApprovedWhatsAppTemplate(env(), "22890681092", "Ama", "Demande"), error => error.code === "template_definition_mismatch");
  });
  assert.equal(posts, 0);
});

test("identifiant WABA absent ou indicateur désactivé: aucune requête réseau", async () => {
  let calls = 0;
  await withFetch(async () => { calls++; throw new Error("ne doit pas être appelé"); }, async () => {
    await assert.rejects(() => sendApprovedWhatsAppTemplate({ ...env(), WA_WABA_ID: "" }, "22890681092", "Ama", "Demande"), error => error.code === "missing_waba_id");
    await assert.rejects(() => sendApprovedWhatsAppTemplate({ ...env(), WA_TEMPLATE_SEND_ENABLED: "false" }, "22890681092", "Ama", "Demande"), error => error.code === "template_disabled");
  });
  assert.equal(calls, 0);
});

test("file d’envoi désactivée par défaut et ne consulte pas D1", async () => {
  const result = await processWhatsAppTemplateQueue({ WA_TEMPLATE_SEND_ENABLED: "false", DB: { prepare() { throw new Error("D1 ne doit pas être interrogée"); } } });
  assert.equal(result.disabled, true);
  assert.equal(result.sent, 0);
});
