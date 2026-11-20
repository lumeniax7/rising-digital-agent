import { test } from "node:test";
import assert from "node:assert/strict";
import { readJsonBody, validPublicHttpsUrl } from "../src/web/security.js";

test("le parseur JSON borné accepte un objet JSON valide", async () => {
  const request = new Request("https://worker.example/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ site_url: "https://example.com" }),
  });
  assert.deepEqual(await readJsonBody(request), { site_url: "https://example.com" });
});

test("le parseur JSON borné refuse un corps trop grand et un JSON invalide", async () => {
  const large = new Request("https://worker.example/api/settings", { method: "PUT", body: "x".repeat(128) });
  await assert.rejects(readJsonBody(large, 64), error => error.status === 413);
  const invalid = new Request("https://worker.example/api/settings", { method: "PUT", body: "not-json" });
  await assert.rejects(readJsonBody(invalid), error => error.status === 400);
});

test("les destinations de webhook doivent être HTTPS publiques et sans identifiants", () => {
  assert.equal(validPublicHttpsUrl("https://ntfy.sh/topic"), true);
  assert.equal(validPublicHttpsUrl("http://ntfy.sh/topic"), false);
  assert.equal(validPublicHttpsUrl("https://user:pass@ntfy.sh/topic"), false);
  assert.equal(validPublicHttpsUrl("https://localhost/hook"), false);
  assert.equal(validPublicHttpsUrl("https://127.0.0.1/hook"), false);
  assert.equal(validPublicHttpsUrl("https://10.1.2.3/hook"), false);
  assert.equal(validPublicHttpsUrl("https://169.254.169.254/latest/meta-data"), false);
  assert.equal(validPublicHttpsUrl("https://[::1]/hook"), false);
});
