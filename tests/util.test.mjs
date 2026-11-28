import { test } from "node:test";
import assert from "node:assert/strict";
import { safeEq, redact, jaccard, backoffMs, utcDay, lomeStamp } from "../src/core/util.js";

test("safeEq résiste aux attaques temporelles", () => {
  assert.ok(safeEq("abc", "abc"));
  assert.ok(!safeEq("abc", "abd"));
  assert.ok(!safeEq("abc", "abcd"));
  assert.ok(!safeEq("abc", null));
});
test("redact masque les jetons Meta et les secrets connus", () => {
  const env = { FB_PAGE_TOKEN: "SECRET123" };
  assert.ok(redact("erreur avec SECRET123 dedans", env).includes("[masqué]"));
  assert.ok(!redact("EAAabcdefghijklmnopqrstuvw", {}).includes("EAAa"));
});
test("jaccard distingue textes proches et différents", () => {
  const a = "Création de site web pour votre entreprise à Lomé";
  assert.ok(jaccard(a, a + " pour entrepreneurs") > 0.4);
  assert.ok(jaccard(a, "Formation sérigraphie et sublimation textiles") < 0.15);
});
test("backoff croît et reste borné", () => {
  const a = backoffMs(0), b = backoffMs(4);
  assert.ok(b > a || b >= 6 * 3600_000);
});
test("utcDay et lomeStamp (Africa/Lome = UTC)", () => {
  const d = new Date("2026-11-15T07:30:00Z");
  assert.equal(utcDay(d), "2026-11-15");
  assert.equal(lomeStamp(d), "2026-11-15 07:30");
});
