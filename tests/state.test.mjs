import { test } from "node:test";
import assert from "node:assert/strict";
import { derivePostStatus } from "../src/core/state.js";
import { tooSimilar } from "../src/content/editorial.js";

test("succès complet uniquement si TOUS les canaux confirmés", () => {
  assert.equal(derivePostStatus([{ status: "published" }, { status: "published" }]), "published");
});
test("échec partiel visible, jamais compté comme succès", () => {
  assert.equal(derivePostStatus([{ status: "published" }, { status: "error" }]), "partial");
  assert.equal(derivePostStatus([{ status: "published" }, { status: "unconfigured" }]), "partial");
});
test("échec complet, en cours, non configuré", () => {
  assert.equal(derivePostStatus([{ status: "error" }]), "error");
  assert.equal(derivePostStatus([{ status: "publishing" }]), "publishing");
  assert.equal(derivePostStatus([{ status: "unconfigured" }, { status: "unconfigured" }]), "unconfigured");
  assert.equal(derivePostStatus([{ status: "manual_required" }]), "manual_required");
});
test("aucun canal => error (jamais 'published')", () => {
  assert.equal(derivePostStatus([]), "error");
});
test("anti-répétition", () => {
  const a = "Création de site web professionnel pour votre entreprise";
  assert.ok(tooSimilar(a, [a]));
  assert.ok(!tooSimilar(a, ["Formation sérigraphie textile personnalisée à Agbelouvé"]));
});
