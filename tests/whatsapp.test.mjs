import { test } from "node:test";
import assert from "node:assert/strict";
import { detectLeadSignal } from "../src/crm/crm.js";
import { handleWhatsApp, processPendingWhatsApp, isHumanHandoff } from "../src/social/whatsapp.js";
import { hmacHex } from "../src/core/crypto.js";
import { graph } from "../src/social/meta.js";

const APP_SECRET = "test-app-secret";
const TOKEN = "test-meta-token";
const payload = JSON.stringify({ object: "whatsapp_business_account", entry: [{ changes: [{ value: {
  messages: [{ id: "wamid.ABC_123==", from: "22890000001", text: { body: "Bonjour, je souhaite des informations sur votre activité." } }],
} }] }] });

async function signedRequest(body = payload, signature = true, db = new FakeD1()) {
  const headers = { "content-type": "application/json" };
  if (signature) headers["x-hub-signature-256"] = `sha256=${await hmacHex(APP_SECRET, body)}`;
  const req = new Request("https://example.test/webhook", { method: "POST", headers, body });
  return { req, env: { DB: db, WA_APP_SECRET: APP_SECRET, WA_TOKEN: TOKEN, WA_PHONE_ID: "phone-123" }, db };
}

test("détection de transfert humain", () => {
  for (const t of ["je veux un remboursement", "je voudrais parler à une personne", "je souhaite parler à un conseiller", "c'est un litige !!", "quel est le contrat ?"])
    assert.ok(isHumanHandoff(t), t);
  assert.ok(!isHumanHandoff("bonjour, je voudrais un site web"));
  assert.ok(!isHumanHandoff("pouvez-vous m'expliquer comment créer un site web ?"));
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

test("signature webhook absente => 401", async () => {
  const { req, env } = await signedRequest(payload, false);
  assert.equal((await handleWhatsApp(req, env)).status, 401);
});

test("signature webhook invalide => 401", async () => {
  const { req, env } = await signedRequest(payload);
  req.headers.set("x-hub-signature-256", `sha256=${"0".repeat(64)}`);
  assert.equal((await handleWhatsApp(req, env)).status, 401);
});

test("signature webhook valide persiste le message avant l’ACK", async () => {
  const { req, env, db } = await signedRequest();
  const response = await handleWhatsApp(req, env);
  assert.equal(response.status, 200);
  assert.equal(db.inbox.size, 1);
  assert.equal(db.inbox.get("wamid.ABC_123==").status, "pending");
});

test("POST sans WA_APP_SECRET non vide est indisponible", async () => {
  const { req, env } = await signedRequest();
  env.WA_APP_SECRET = "  ";
  assert.equal((await handleWhatsApp(req, env)).status, 503);
});

test("limite le corps avant parsing", async () => {
  const body = "x".repeat(256 * 1024 + 1);
  const { req, env } = await signedRequest(body, false);
  // Fournit une signature syntaxiquement valide sans dépendre du contenu ; le corps est rejeté avant le HMAC.
  req.headers.set("x-hub-signature-256", `sha256=${"a".repeat(64)}`);
  assert.equal((await handleWhatsApp(req, env)).status, 413);
});

test("déduplication durable par wamid", async () => {
  const db = new FakeD1();
  const first = await signedRequest(payload, true, db);
  const second = await signedRequest(payload, true, db);
  assert.equal((await handleWhatsApp(first.req, first.env)).status, 200);
  assert.equal((await handleWhatsApp(second.req, second.env)).status, 200);
  assert.equal(db.inbox.size, 1);
});

test("worker reprend après échec malgré le message entrant déjà inséré et ne double pas la réponse persistée", async () => {
  const db = new FakeD1({ failServicesOnce: true });
  const { req, env } = await signedRequest(payload, true, db);
  assert.equal((await handleWhatsApp(req, env)).status, 200);

  const failed = await processPendingWhatsApp(env, 10);
  assert.deepEqual(failed, { claimed: 1, completed: 0, retried: 1, failed: 0 });
  const item = db.inbox.get("wamid.ABC_123==");
  assert.equal(item.status, "pending");
  assert.equal(item.attempts, 1);
  assert.ok(db.messages.some(m => m.direction === "in" && m.external_id === item.wamid));

  // Rend la reprise immédiatement échue sans attendre le backoff normal.
  item.next_attempt_at = "2000-01-01T00:00:00.000Z";
  const originalFetch = globalThis.fetch;
  let sends = 0;
  globalThis.fetch = async (_url, options) => {
    sends++;
    assert.equal(options.headers.authorization, `Bearer ${TOKEN}`);
    return new Response(JSON.stringify({ messages: [{ id: "wamid.OUT_1" }] }), { status: 200 });
  };
  try {
    const resumed = await processPendingWhatsApp(env, 10);
    assert.deepEqual(resumed, { claimed: 1, completed: 1, retried: 0, failed: 0 });
    assert.equal(item.status, "completed");
    assert.ok(item.reply_external_id);
    assert.equal(db.messages.filter(m => m.direction === "out").length, 1);
    assert.deepEqual(await processPendingWhatsApp(env, 10), { claimed: 0, completed: 0, retried: 0, failed: 0 });
    assert.equal(sends, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test("client Meta trim les espaces externes et refuse CR/LF sans exposer le jeton", async () => {
  const originalFetch = globalThis.fetch;
  let authorization;
  globalThis.fetch = async (_url, options) => {
    authorization = options.headers.authorization;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  try {
    await graph({}, "GET", "/me", null, `  ${TOKEN}  `);
    assert.equal(authorization, `Bearer ${TOKEN}`);
    await assert.rejects(() => graph({}, "GET", "/me", null, `${TOKEN}\r\nX-Evil: yes`), err => {
      assert.doesNotMatch(err.message, new RegExp(TOKEN));
      return /invalide/.test(err.message);
    });
  } finally { globalThis.fetch = originalFetch; }
});

class FakeD1 {
  constructor({ failServicesOnce = false } = {}) {
    this.inbox = new Map();
    this.contacts = new Map();
    this.conversations = [];
    this.messages = [];
    this.nextContactId = 1;
    this.nextConversationId = 1;
    this.failServicesOnce = failServicesOnce;
    this.DB = this;
  }
  prepare(sql) {
    const db = this;
    let args = [];
    const stmt = {
      bind(...values) { args = values; return stmt; },
      async run() { return db.run(sql, args); },
      async first() { return db.first(sql, args); },
      async all() { return db.all(sql, args); },
    };
    return stmt;
  }
  async batch(statements) {
    const result = [];
    for (const statement of statements) result.push(await statement.run());
    return result;
  }
  async run(sql, a) {
    const q = sql.replace(/\s+/g, " ").trim();
    if (q.startsWith("CREATE TABLE")) return { meta: { changes: 0 } };
    if (q.startsWith("INSERT OR IGNORE INTO wa_inbox")) {
      if (!this.inbox.has(a[0])) this.inbox.set(a[0], { wamid: a[0], tenant_id: a[1], sender: a[2], payload: a[3], status: "pending", attempts: 0, next_attempt_at: null, last_error: null, claimed_at: null, reply_external_id: null, created_at: a[4] });
      return { meta: { changes: 1 } };
    }
    if (q.startsWith("UPDATE wa_inbox SET status='processing'")) {
      const row = this.inbox.get(a[2]);
      if (!row || !((row.status === "pending" && (!row.next_attempt_at || row.next_attempt_at <= a[3])) || (row.status === "processing" && row.claimed_at <= a[4]))) return { meta: { changes: 0 } };
      row.status = "processing"; row.attempts++; row.claimed_at = a[0]; row.updated_at = a[1];
      return { meta: { changes: 1 } };
    }
    if (q.startsWith("UPDATE wa_inbox SET status=?")) {
      const row = this.inbox.get(a[4]);
      if (!row) return { meta: { changes: 0 } };
      [row.status, row.next_attempt_at, row.last_error, row.updated_at] = a;
      row.claimed_at = null;
      return { meta: { changes: 1 } };
    }
    if (q.startsWith("UPDATE wa_inbox SET status='completed',reply_external_id")) {
      const row = this.inbox.get(a[2]);
      if (!row || row.status !== "processing") return { meta: { changes: 0 } };
      row.status = "completed"; row.reply_external_id = a[0]; row.next_attempt_at = null; row.last_error = null; row.claimed_at = null; row.updated_at = a[1];
      return { meta: { changes: 1 } };
    }
    if (q.startsWith("UPDATE wa_inbox SET status='completed'")) {
      const row = this.inbox.get(a[1]);
      if (row) { row.status = "completed"; row.next_attempt_at = null; row.last_error = null; row.claimed_at = null; row.updated_at = a[0]; }
      return { meta: { changes: row ? 1 : 0 } };
    }
    if (q.startsWith("INSERT OR IGNORE INTO contacts")) {
      const k = `${a[0]}:${a[1]}:${a[2]}`;
      if (!this.contacts.has(k)) this.contacts.set(k, { id: this.nextContactId++, tenant_id: a[0], channel: a[1], external_id: a[2] });
      return { meta: { changes: 1 } };
    }
    if (q.startsWith("UPDATE contacts")) return { meta: { changes: 1 } };
    if (q.startsWith("INSERT INTO conversations")) {
      this.conversations.push({ id: this.nextConversationId++, tenant_id: a[0], channel: a[1], contact_id: a[2], handoff: 0, last_msg_at: a[3] });
      return { meta: { changes: 1, last_row_id: this.conversations.at(-1).id } };
    }
    if (q.startsWith("INSERT OR IGNORE INTO messages")) {
      if (!this.messages.some(m => m.external_id === a[3])) this.messages.push({ tenant_id: a[0], conversation_id: a[1], direction: a[2], external_id: a[3], body: a[4], ts: a[5], id: this.messages.length + 1 });
      return { meta: { changes: 1 } };
    }
    if (q.startsWith("UPDATE conversations")) return { meta: { changes: 1 } };
    if (q.startsWith("INSERT INTO events")) return { meta: { changes: 1 } };
    if (q.startsWith("INSERT INTO leads")) return { meta: { changes: 1, last_row_id: 1 } };
    if (q.startsWith("UPDATE leads")) return { meta: { changes: 1 } };
    if (q.startsWith("INSERT INTO ai_usage")) return { meta: { changes: 1 } };
    throw new Error(`FakeD1.run SQL inattendu: ${q}`);
  }
  async first(sql, a) {
    const q = sql.replace(/\s+/g, " ").trim();
    if (q.startsWith("SELECT id FROM tenants")) return { id: 7 };
    if (q.startsWith("SELECT * FROM wa_inbox")) return this.inbox.get(a[0]) || null;
    if (q.startsWith("SELECT id FROM contacts")) return [...this.contacts.values()].find(c => c.tenant_id === a[0] && c.channel === a[1] && c.external_id === a[2]) || null;
    if (q.startsWith("SELECT id, handoff FROM conversations")) return this.conversations.find(c => c.tenant_id === a[0] && c.channel === a[1] && c.contact_id === a[2]) || null;
    if (q.startsWith("SELECT id,status FROM leads")) return null;
    if (q.startsWith("SELECT v FROM meta")) return { v: "0" };
    if (q.startsWith("SELECT ts FROM messages")) return this.messages.filter(m => m.direction === "out").at(-1) || null;
    return null;
  }
  async all(sql, a) {
    const q = sql.replace(/\s+/g, " ").trim();
    if (q.startsWith("SELECT wamid FROM wa_inbox")) {
      return { results: [...this.inbox.values()].filter(r => (r.status === "pending" && (!r.next_attempt_at || r.next_attempt_at <= a[0])) || (r.status === "processing" && r.claimed_at <= a[1])).slice(0, a[2]).map(r => ({ wamid: r.wamid })) };
    }
    if (q.startsWith("SELECT title FROM services")) {
      if (this.failServicesOnce) { this.failServicesOnce = false; throw new Error("erreur temporaire service"); }
      return { results: [] };
    }
    if (q.startsWith("SELECT * FROM ai_providers")) return { results: [] };
    if (q.startsWith("SELECT * FROM memory")) return { results: [] };
    if (q.startsWith("SELECT direction, body FROM messages")) return { results: [...this.messages].sort((x, y) => y.id - x.id).slice(0, 6).map(({ direction, body }) => ({ direction, body })).reverse() };
    return { results: [] };
  }
}
