import { test } from "node:test";
import assert from "node:assert/strict";
import { monitorWhatsAppQueue } from "../src/reports/reports.js";

class MonitorD1 {
  constructor(destination = null) { this.destination = destination; this.fingerprint = ""; }
  prepare(sql) {
    const db = this;
    let args = [];
    const stmt = {
      bind(...values) { args = values; return stmt; },
      async first() {
        if (sql.includes("k='report_webhook_url'")) return db.destination ? { v: db.destination } : null;
        if (sql.includes("FROM wa_inbox")) return { failed: 2, pending: 0, stale_processing: 0, oldest_pending: null };
        if (sql.includes("FROM wa_template_queue")) return { failed: 0, stale_processing: 0 };
        if (sql.includes("k='wa_queue_alert_fingerprint'")) return db.fingerprint ? { v: db.fingerprint } : null;
        return null;
      },
      async run() {
        if (sql.includes("wa_queue_alert_fingerprint")) db.fingerprint = args[0];
        return { meta: { changes: 1 } };
      },
    };
    return stmt;
  }
}

test("aucune alerte externe n’est envoyée sans destination configurée", async () => {
  let requests = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => { requests++; throw new Error("ne doit pas appeler fetch"); };
  try {
    const result = await monitorWhatsAppQueue({ DB: new MonitorD1() });
    assert.deepEqual(result, { configured: false, notified: false });
    assert.equal(requests, 0);
  } finally { globalThis.fetch = original; }
});

test("alerte agrégée sans données client et dédupliquée", async () => {
  const db = new MonitorD1("https://alerts.example/hook");
  const bodies = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, "https://alerts.example/hook");
    bodies.push(options.body);
    return new Response("ok", { status: 200 });
  };
  try {
    const first = await monitorWhatsAppQueue({ DB: db, WA_ALERT_FAILED_THRESHOLD: "1" });
    const second = await monitorWhatsAppQueue({ DB: db, WA_ALERT_FAILED_THRESHOLD: "1" });
    assert.equal(first.notified, true);
    assert.equal(second.notified, false);
    assert.equal(bodies.length, 1);
    assert.match(bodies[0], /échecs=2/);
    assert.doesNotMatch(bodies[0], /228\d{7,}/);
    assert.doesNotMatch(bodies[0], /Bonjour|Bearer|whatsapp-token/i);
  } finally { globalThis.fetch = original; }
});
